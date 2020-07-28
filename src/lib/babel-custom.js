import { createConfigItem } from '@babel/core';
import babelPlugin from 'rollup-plugin-babel';
import merge from 'lodash.merge';
import { isTruthy } from '../utils';

const mergeConfigItems = (type, ...configItemsToMerge) => {
	const mergedItems = [];

	configItemsToMerge.forEach(configItemToMerge => {
		configItemToMerge.forEach(item => {
			const itemToMergeWithIndex = mergedItems.findIndex(
				mergedItem => mergedItem.file.resolved === item.file.resolved,
			);

			if (itemToMergeWithIndex === -1) {
				mergedItems.push(item);
				return;
			}

			mergedItems[itemToMergeWithIndex] = createConfigItem(
				[
					mergedItems[itemToMergeWithIndex].file.resolved,
					merge(mergedItems[itemToMergeWithIndex].options, item.options),
				],
				{
					type,
				},
			);
		});
	});

	return mergedItems;
};

const createConfigItems = (type, items) => {
	return items.map(({ name, ...options }) => {
		return createConfigItem([require.resolve(name), options], { type });
	});
};

export default babelPlugin.custom(babelCore => {
	return {
		// Passed the plugin options.
		options({ custom: customOptions, ...pluginOptions }) {
			return {
				// Pull out any custom options that the plugin might have.
				customOptions,

				// Pass the options back with the two custom options removed.
				pluginOptions,
			};
		},

		config(config, { customOptions }) {
			const defaultPlugins = createConfigItems(
				'plugin',
				[
					{
						name: '@babel/plugin-transform-react-jsx',
						pragma: customOptions.jsx || 'h',
						pragmaFrag: customOptions.jsxFragment || 'Fragment',
					},
					isTruthy(customOptions.defines) && {
						name: 'babel-plugin-transform-replace-expressions',
						replace: customOptions.defines,
					},
					{
						name: 'babel-plugin-transform-async-to-promises',
						inlineHelpers: true,
						externalHelpers: true,
					},
					{
						name: '@babel/plugin-proposal-class-properties',
						loose: true,
					},
					{
						name: '@babel/plugin-transform-regenerator',
						async: false,
					},
				].filter(Boolean),
			);

			let babelOptions = {
				presets: [],
				plugins: [],
			};
			if (config.hasFilesystemConfig()) {
				babelOptions = config.options;

				if (babelOptions.presets) {
					babelOptions.presets = babelOptions.presets.map(preset => {
						// When preset-env is configured we want to make sure we override some settings.
						// We want to make sure microbundle is still fast & creates small bundles
						if (preset.file.request === '@babel/preset-env') {
							preset = createConfigItem(
								[
									preset.file.resolved,
									merge(
										{
											loose: true,
											targets: customOptions.targets,
										},
										preset.options,
										{
											modules: false,
											exclude: merge(
												[
													'transform-async-to-generator',
													'transform-regenerator',
												],
												preset.options.exclude || [],
											),
										},
									),
								],
								{
									type: `preset`,
								},
							);
						}

						return preset;
					});
				}
			} else {
				babelOptions.presets = createConfigItems('preset', [
					{
						name: '@babel/preset-env',
						targets: customOptions.targets,
						modules: false,
						loose: true,
						exclude: ['transform-async-to-generator', 'transform-regenerator'],
					},
				]);
			}

			// Merge babelrc & our plugins together
			babelOptions.plugins = mergeConfigItems(
				'plugin',
				defaultPlugins,
				babelOptions.plugins || [],
			);

			return babelOptions;
		},
	};
});
