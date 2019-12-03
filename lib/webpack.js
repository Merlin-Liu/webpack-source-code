/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const webpackOptionsSchema = require("../schemas/WebpackOptions.json");
const Compiler = require("./Compiler");
const MultiCompiler = require("./MultiCompiler");
const WebpackOptionsApply = require("./WebpackOptionsApply");
const WebpackOptionsDefaulter = require("./WebpackOptionsDefaulter");
const NodeEnvironmentPlugin = require("./node/NodeEnvironmentPlugin");
const validateSchema = require("./validateSchema");

/** @typedef {import("../declarations/WebpackOptions").WebpackOptions} WebpackOptions */
/** @typedef {import("./MultiStats")} MultiStats */
/** @typedef {import("./Stats")} Stats */

/**
 * @template T
 * @callback Callback
 * @param {Error=} err
 * @param {T=} stats
 * @returns {void}
 */

/**
 * @param {WebpackOptions[]} childOptions options array
 * @returns {MultiCompiler} a multi-compiler
 */
const createMultiCompiler = childOptions => {
	const compilers = childOptions.map(options => createCompiler(options));
	const compiler = new MultiCompiler(compilers);
	for (const childCompiler of compilers) {
		if (childCompiler.options.dependencies) {
			compiler.setDependencies(
				childCompiler,
				childCompiler.options.dependencies
			);
		}
	}
	return compiler;
};

/**
 * @param {WebpackOptions} options options object
 * @returns {Compiler} a compiler
 * webpack核心方法，创建编译器，返回的一个编译器
 */
const createCompiler = options => {
	options = new WebpackOptionsDefaulter().process(options);

	const compiler = new Compiler(options.context);
	compiler.options = options;

	new NodeEnvironmentPlugin({
		infrastructureLogging: options.infrastructureLogging
	}).apply(compiler);

	// 遍历plugin数组，应用插件
	if (Array.isArray(options.plugins)) {
		for (const plugin of options.plugins) {
			// plugin的第一种写法，直接是个函数，接收的参数是compiler实例
			if (typeof plugin === "function") {
				plugin.call(compiler, compiler);
			}
			// plugin的第二种写法，是个对象，对象拥有apply方法，接收的参数是compiler实例
			else {
				plugin.apply(compiler);
			}
		}
	}

	// 引入Tapable概念
	compiler.hooks.environment.call();
	compiler.hooks.afterEnvironment.call();

	// 处理传入的options
	// 根据options初始化一些内置插件
	compiler.options = new WebpackOptionsApply().process(options, compiler);
	// process函数执行完，webpack将所有它关心的hook消息都注册完成，等待后续编译过程中挨个触发

	return compiler;
};

/**
 * @param {WebpackOptions | WebpackOptions[]} options options object
 * @param {Callback<Stats | MultiStats>=} callback callback
 * @returns {Compiler | MultiCompiler} the compiler object
 * webpack入口函数，使用这个函数进行打包等一系列操作
 */
const webpack = (options, callback) => {
	// 对传入的options进行模式化校验
	validateSchema(webpackOptionsSchema, options);

	/** @type {TODO} */
	let compiler;
	let watch = false;
	let watchOptions;

	// 传入的配置是个数组，那么数组内的所有配置都会构建，暂时先不研究
	if (Array.isArray(options)) {
		compiler = createMultiCompiler(options);
		watch = options.some(options => options.watch);
		watchOptions = options.map(options => options.watchOptions || {});
	}
	else {
		compiler = createCompiler(options);
		watch = options.watch; // 配置的watch，监听文件变动，实时进行打包
		watchOptions = options.watchOptions || {}; // watchOptions 参考文档
	}

	// 如果传入了回调，自动执行run方法，否则需要手动执行run进行打包
	if (callback) {
		if (watch) {
			compiler.watch(watchOptions, callback);
		}
		else {
			compiler.run((err, stats) => {
				compiler.close(err2 => {
					callback(err || err2, stats);
				});
			});
		}
	}

	// 返回一个compiler实例
	return compiler;
};

module.exports = webpack;
