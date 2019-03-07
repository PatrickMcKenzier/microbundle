import fs from 'fs';
import { resolve, relative, dirname, basename } from 'path';
import chalk from 'chalk';
import { map, series } from 'asyncro';
import promisify from 'es6-promisify';
import glob from 'glob';
import autoprefixer from 'autoprefixer';
import { rollup, watch } from 'rollup';
import nodent from 'rollup-plugin-nodent';
import commonjs from 'rollup-plugin-commonjs';
import nodeResolve from 'rollup-plugin-node-resolve';
import buble from 'rollup-plugin-buble';
import uglify from 'rollup-plugin-uglify';
import postcss from 'rollup-plugin-postcss';
import alias from 'rollup-plugin-strict-alias';
import gzipSize from 'gzip-size';
import prettyBytes from 'pretty-bytes';
import shebangPlugin from 'rollup-plugin-preserve-shebang';
import flow from 'rollup-plugin-flow';
import camelCase from 'camelcase';

const interopRequire = m => m.default || m;
const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);
const isDir = name => stat(name).then( stats => stats.isDirectory() ).catch( () => false );
const isFile = name => stat(name).then( stats => stats.isFile() ).catch( () => false );
const safeVariableName = name => camelCase(name.toLowerCase().replace(/((^[^a-zA-Z]+)|[^\w.-])|([^a-zA-Z0-9]+$)/g, ''));

const WATCH_OPTS = {
	exclude: 'node_modules/**'
};

export default async function microbundle(options) {
	let cwd = options.cwd = resolve(process.cwd(), options.cwd);

	try {
		options.pkg = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'));
	}
	catch (err) {
		console.warn(chalk.yellow(`${chalk.yellow.inverse('WARN')} no package.json found.`));
		let msg = String(err.message || err);
		if (!msg.match(/ENOENT/)) console.warn(`  ${chalk.red.dim(msg)}`);
		options.pkg = {};
	}

	if (!options.pkg.name) {
		options.pkg.name = basename(options.cwd);
		console.warn(chalk.yellow(`${chalk.yellow.inverse('WARN')} missing package.json "name" field. Assuming "${options.pkg.name}".`));
	}

	options.input = [];
	[].concat(
		options.entries && options.entries.length ? options.entries : options.pkg.source || (await isDir(resolve(cwd, 'src')) && 'src/index.js') || (await isFile(resolve(cwd, 'index.js')) && 'index.js') || options.pkg.module
	).map( file => glob.sync(resolve(cwd, file)) ).forEach( file => options.input.push(...file) );

	let main = resolve(cwd, options.output || options.pkg.main || 'dist');
	if (!main.match(/\.[a-z]+$/) || await isDir(main)) {
		main = resolve(main, `${options.pkg.name}.js`);
	}
	options.output = main;

	let entries = (await map([].concat(options.input), async file => {
		file = resolve(cwd, file);
		if (await isDir(file)) {
			file = resolve(file, 'index.js');
		}
		return file;
	})).filter( (item, i, arr) => arr.indexOf(item)===i );

	options.entries = entries;

	options.multipleEntries = entries.length>1;

	let formats = (options.format || options.formats).split(',');
	// always compile cjs first if it's there:
	formats.sort( (a, b) => a==='cjs' ? -1 : a>b ? 1 : 0);

	let steps = [];
	for (let i=0; i<entries.length; i++) {
		for (let j=0; j<formats.length; j++) {
			steps.push(createConfig(options, entries[i], formats[j], i===0 && j===0));
		}
	}

	async function getSizeInfo(code, filename) {
		let size = await gzipSize(code);
		let prettySize = prettyBytes(size);
		let color = size < 5000 ? 'green' : size > 40000 ? 'red' : 'yellow';
		return `${' '.repeat(10-prettySize.length)}${chalk[color](prettySize)}: ${chalk.white(basename(filename))}`;
	}

	if (options.watch) {
		return new Promise( (resolve, reject) => {
			process.stdout.write(chalk.blue(`Watching source, compiling to ${relative(cwd, dirname(options.output))}:\n`));
			steps.map( options => {
				watch(Object.assign({
					output: options.outputOptions,
					watch: WATCH_OPTS
				}, options.inputOptions)).on('event', e => {
					if (e.code==='ERROR' || e.code==='FATAL') {
						return reject(e);
					}
					if (e.code==='END') {
						getSizeInfo(options._code, options.outputOptions.file).then( text => {
							process.stdout.write(`Wrote ${text.trim()}\n`);
						});
					}
				});
			});
		});
	}

	let cache;
	let out = await series(steps.map( ({ inputOptions, outputOptions }) => async () => {
		inputOptions.cache = cache;
		let bundle = await rollup(inputOptions);
		cache = bundle;
		await bundle.write(outputOptions);
		return await getSizeInfo(bundle._code, outputOptions.file);
	}));

	return chalk.blue(`Build output to ${relative(cwd, dirname(options.output)) || '.'}:`) + '\n   ' + out.join('\n   ');
}


function createConfig(options, entry, format, writeMeta) {
	let { pkg } = options;

	let external = ['dns', 'fs', 'path', 'url'].concat(
		Object.keys(pkg.peerDependencies || {}),
		options.entries.filter( e => e!==entry )
	);

	let aliases = {};
	// since we transform src/index.js, we need to rename imports for it:
	if (options.multipleEntries) {
		aliases['.'] = './' + basename(options.output);
		external.push('.');
	}

	let useNodeResolve = true;
	if (options.inline === 'all') {
		useNodeResolve = true;
	}
	else if (options.external==='all' || options.inline==='none') {
		useNodeResolve = false;
		external = external.concat(Object.keys(pkg.dependencies));
	}

	let globals = external.reduce( (globals, name) => {
		// valid JS identifiers are usually library globals:
		if (name.match(/^[a-z_$][a-z0-9_$]*$/)) {
			globals[name] = name;
		}
		return globals;
	}, {});

	function replaceName(filename, name) {
		return resolve(dirname(filename), name + basename(filename).replace(/^[^.]+/, ''));
	}

	let mainNoExtension = options.output;
	if (options.multipleEntries) {
		let name = entry.match(/(\\|\/)index(\.(umd|cjs|es|m))?\.js$/) ? mainNoExtension : entry;
		mainNoExtension = resolve(dirname(mainNoExtension), basename(name));
	}
	mainNoExtension = mainNoExtension.replace(/(\.(umd|cjs|es|m))?\.js$/, '');

	let moduleMain = replaceName(pkg.module && !pkg.module.match(/src\//) ? pkg.module : pkg['jsnext:main'] || 'x.m.js', mainNoExtension);
	let cjsMain = replaceName(pkg['cjs:main'] || 'x.js', mainNoExtension);
	let umdMain = replaceName(pkg['umd:main'] || 'x.umd.js', mainNoExtension);

	// let rollupName = safeVariableName(basename(entry).replace(/\.js$/, ''));

	let nameCache = {};
	let mangleOptions = options.pkg.mangle || false;

	let exportType;
	if (format!='es') {
		try {
			let file = fs.readFileSync(entry, 'utf-8');
			let hasDefault = /\bexport\s*default\s*[a-zA-Z_$]/.test(file);
			let hasNamed = /\bexport\s*(let|const|var|async|function\*?)\s*[a-zA-Z_$*]/.test(file) || /^\s*export\s*\{/m.test(file);
			if (hasDefault && hasNamed) exportType = 'default';
		}
		catch (e) {}
	}

	let config = {
		inputOptions: {
			input: exportType ? resolve(__dirname, '../src/lib/__entry__.js') : entry,
			external,
			plugins: [].concat(
				alias({
					__microbundle_entry__: entry
				}),
				postcss({
					plugins: [
						autoprefixer()
					],
					// only write out CSS for the first bundle (avoids pointless extra files):
					inject: false,
					extract: !!writeMeta
				}),
				flow({ all: true }),
				nodent({
					exclude: 'node_modules/**',
					noRuntime: true,
					promises: true,
					transformations: {
						forOf: false
					},
					parser: {
						plugins: {
							jsx: require('acorn-jsx')
						}
					}
				}),
				buble({
					exclude: 'node_modules/**',
					jsx: options.jsx || 'h',
					objectAssign: options.assign || 'Object.assign',
					transforms: {
						dangerousForOf: true,
						dangerousTaggedTemplateString: true
					}
				}),
				useNodeResolve && commonjs({
					include: 'node_modules/**'
				}),
				useNodeResolve && nodeResolve({
					module: true,
					jsnext: true,
					browser: options.target!=='node'
				}),
				// We should upstream this to rollup
				// format==='cjs' && replace({
				// 	[`module.exports = ${rollupName};`]: '',
				// 	[`var ${rollupName} =`]: 'module.exports ='
				// }),
				// This works for the general case, but could cause nasty scope bugs.
				// format==='umd' && replace({
				// 	[`return ${rollupName};`]: '',
				// 	[`var ${rollupName} =`]: 'return'
				// }),
				// format==='es' && replace({
				// 	[`export default ${rollupName};`]: '',
				// 	[`var ${rollupName} =`]: 'export default'
				// }),
				options.compress!==false && uglify({
					output: { comments: false },
					mangle: {
						toplevel: format==='cjs' || format==='es',
						properties: mangleOptions ? {
							regex: mangleOptions.regex ? new RegExp(mangleOptions.regex) : null,
							reserved: mangleOptions.reserved || []
						} : false
					},
					nameCache
				}, format==='es' ? interopRequire(require('uglify-es')).minify : undefined),
				mangleOptions && {
					// before hook
					options() {
						try {
							nameCache = JSON.parse(fs.readFileSync(resolve(options.cwd, 'mangle.json'), 'utf8'));
						}
						catch (e) {}
					},
					// after hook
					onwrite() {
						if (writeMeta && nameCache) {
							fs.writeFile(resolve(options.cwd, 'mangle.json'), JSON.stringify(nameCache, null, 2), Object);
						}
					}
				},
				{ ongenerate({ bundle }, { code }) {
					config._code = bundle._code = code;
				} },
				shebangPlugin()
			).filter(Boolean)
		},

		outputOptions: {
			exports: exportType ? 'default' : undefined,
			paths: aliases,
			globals,
			strict: options.strict===true,
			legacy: true,
			freeze: false,
			sourcemap: true,
			treeshake: {
				propertyReadSideEffects: false
			},
			format,
			name: options.name || pkg.amdName || safeVariableName(pkg.name),
			file: resolve(options.cwd, (format==='es' && moduleMain) || (format==='umd' && umdMain) || cjsMain)
		}
	};

	return config;
}
