/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const EntryDependency = require("./dependencies/EntryDependency");

/** @typedef {import("./Compiler")} Compiler */

class EntryPlugin {
	/**
	 * An entry plugin which will handle
	 * creation of the EntryDependency
	 *
	 * @param {string} context context path
	 * @param {string} entry entry path
	 * @param {string} name entry key name
	 */
	constructor(context, entry, name) {
		this.context = context;
		this.entry = entry;
		this.name = name;
	}

	/**
	 * @param {Compiler} compiler the compiler instance
	 * @returns {void}
	 */
	apply(compiler) {
		compiler.hooks.compilation.tap("EntryPlugin",
			(compilation, { normalModuleFactory }) => {
				compilation.dependencyFactories.set(
					EntryDependency,
					normalModuleFactory
				);
			}
		);

		// 监听make钩子
		compiler.hooks.make.tapAsync("EntryPlugin", (compilation, callback) => {
			consola.info('9⃣️  触发「`make`」钩子注册的方法「`EntryPlugin`」，开始执行`Compilation`的「`addEntry`」方法添加entry')

			const { entry, name, context } = this;

			const dep = EntryPlugin.createDependency(entry, name);

			compilation.addEntry(context, dep, name, err => {
				callback(err);
			});
		});
	}

	/**
	 * @param {string} entry entry request
	 * @param {string} name entry name
	 * @returns {EntryDependency} the dependency
	 */
	static createDependency(entry, name) {
		const dep = new EntryDependency(entry);
		dep.loc = { name };
		return dep;
	}
}

module.exports = EntryPlugin;
