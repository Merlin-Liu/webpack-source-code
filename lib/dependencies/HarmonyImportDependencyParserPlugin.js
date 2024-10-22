/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const consola = require('consola')
const HotModuleReplacementPlugin = require("../HotModuleReplacementPlugin");
const ConstDependency = require("./ConstDependency");
const HarmonyAcceptDependency = require("./HarmonyAcceptDependency");
const HarmonyAcceptImportDependency = require("./HarmonyAcceptImportDependency");
const HarmonyImportSideEffectDependency = require("./HarmonyImportSideEffectDependency");
const HarmonyImportSpecifierDependency = require("./HarmonyImportSpecifierDependency");

/** @typedef {import("../optimize/InnerGraphPlugin").InnerGraph} InnerGraph */
/** @typedef {import("../optimize/InnerGraphPlugin").TopLevelSymbol} TopLevelSymbol */
/** @typedef {import("./HarmonyImportDependency")} HarmonyImportDependency */

const harmonySpecifierTag = Symbol("harmony import");

/**
 * @typedef {Object} HarmonySettings
 * @property {string[]} ids
 * @property {string} source
 * @property {number} sourceOrder
 * @property {string} name
 * @property {boolean} await
 */

module.exports = class HarmonyImportDependencyParserPlugin {
	constructor(options) {
		const { module: moduleOptions } = options;
		this.strictExportPresence = moduleOptions.strictExportPresence;
		this.strictThisContextOnImports = moduleOptions.strictThisContextOnImports;
		this.importAwait = options.importAwait;
	}

	apply(parser) {
		parser.hooks.import.tap("HarmonyImportDependencyParserPlugin", (statement, source) => {
			parser.state.lastHarmonyImportOrder = (parser.state.lastHarmonyImportOrder || 0) + 1;
			const clearDep = new ConstDependency("", statement.range);
			clearDep.loc = statement.loc;
			parser.state.module.addPresentationalDependency(clearDep);
			const sideEffectDep = new HarmonyImportSideEffectDependency(source, parser.state.lastHarmonyImportOrder);
			sideEffectDep.loc = statement.loc;
			sideEffectDep.await = statement.await;

			// 🔥 此处将依赖push入module的dependencies
			consola.success(`🌟 触发import钩子对应方法，将模块导入的依赖添加入\`NormalModule\`的\`dependencies\`中，依赖项为\`${sideEffectDep.userRequest}\``)
			parser.state.module.addDependency(sideEffectDep);

			if (statement.await && !this.importAwait) {
				throw new Error("Used 'import await' but import-await experiment is not enabled (set experiments.importAwait: true to enable it)");
			}
			return true;
		});

		parser.hooks.importSpecifier.tap("HarmonyImportDependencyParserPlugin", (statement, source, id, name) => {
			const ids = id === null ? [] : [id];
			parser.tagVariable(name, harmonySpecifierTag, {
				name,
				source,
				ids,
				sourceOrder: parser.state.lastHarmonyImportOrder,
				await: statement.await
			});

			return true;
		});

		/**
		 * @param {HarmonyImportSpecifierDependency} dep dependency
		 * @returns {void}
		 */
		const addDepToInnerGraph = dep => {
			const { harmonyAllExportDependentDependencies } = parser.state;
			if (!harmonyAllExportDependentDependencies) return;
			const innerGraph =
				/** @type {InnerGraph} */ (parser.state.harmonyInnerGraph);
			if (!innerGraph) return;
			harmonyAllExportDependentDependencies.add(dep);
			const currentTopLevelSymbol =
				/** @type {TopLevelSymbol} */ (parser.state.currentTopLevelSymbol);
			if (!currentTopLevelSymbol) {
				innerGraph.set(dep, true);
			} else {
				innerGraph.set(dep, new Set([currentTopLevelSymbol]));
			}
		};

		parser.hooks.expression
			.for(harmonySpecifierTag)
			.tap("HarmonyImportDependencyParserPlugin", expr => {
				const settings = parser.currentTagData; /** @type {HarmonySettings} */
				const dep = new HarmonyImportSpecifierDependency(
					settings.source,
					settings.sourceOrder,
					settings.ids,
					settings.name,
					expr.range,
					this.strictExportPresence
				);
				dep.shorthand = parser.scope.inShorthand;
				dep.directImport = true;
				dep.asiSafe = !parser.isAsiPosition(expr.range[0]);
				dep.await = settings.await;
				dep.loc = expr.loc;
				parser.state.module.addDependency(dep);
				addDepToInnerGraph(dep);
				return true;
			});
		parser.hooks.expressionMemberChain
			.for(harmonySpecifierTag)
			.tap("HarmonyImportDependencyParserPlugin", (expr, members) => {
				const settings = /** @type {HarmonySettings} */ (parser.currentTagData);
				const ids = settings.ids.concat(members);
				const dep = new HarmonyImportSpecifierDependency(
					settings.source,
					settings.sourceOrder,
					ids,
					settings.name,
					expr.range,
					this.strictExportPresence
				);
				dep.await = settings.await;
				dep.asiSafe = !parser.isAsiPosition(expr.range[0]);
				dep.loc = expr.loc;
				parser.state.module.addDependency(dep);
				addDepToInnerGraph(dep);
				return true;
			});
		parser.hooks.callMemberChain
			.for(harmonySpecifierTag)
			.tap("HarmonyImportDependencyParserPlugin", (expr, members) => {
				const args = expr.arguments;
				expr = expr.callee;
				const settings = /** @type {HarmonySettings} */ (parser.currentTagData);
				const ids = settings.ids.concat(members);
				const dep = new HarmonyImportSpecifierDependency(
					settings.source,
					settings.sourceOrder,
					ids,
					settings.name,
					expr.range,
					this.strictExportPresence
				);
				dep.directImport = members.length === 0;
				dep.await = settings.await;
				dep.call = true;
				dep.asiSafe = !parser.isAsiPosition(expr.range[0]);
				// only in case when we strictly follow the spec we need a special case here
				dep.namespaceObjectAsContext =
					members.length > 0 && this.strictThisContextOnImports;
				dep.loc = expr.loc;
				parser.state.module.addDependency(dep);
				if (args) parser.walkExpressions(args);
				addDepToInnerGraph(dep);
				return true;
			});
		const { hotAcceptCallback, hotAcceptWithoutCallback } = HotModuleReplacementPlugin.getParserHooks(parser);
		hotAcceptCallback.tap(
			"HarmonyImportDependencyParserPlugin",
			(expr, requests) => {
				if (!parser.state.harmonyModule) {
					// This is not a harmony module, skip it
					return;
				}
				const dependencies = requests.map(request => {
					const dep = new HarmonyAcceptImportDependency(request);
					dep.loc = expr.loc;
					parser.state.module.addDependency(dep);
					return dep;
				});
				if (dependencies.length > 0) {
					const dep = new HarmonyAcceptDependency(
						expr.range,
						dependencies,
						true
					);
					dep.loc = expr.loc;
					parser.state.module.addDependency(dep);
				}
			}
		);
		hotAcceptWithoutCallback.tap(
			"HarmonyImportDependencyParserPlugin",
			(expr, requests) => {
				if (!parser.state.harmonyModule) {
					// This is not a harmony module, skip it
					return;
				}
				const dependencies = requests.map(request => {
					const dep = new HarmonyAcceptImportDependency(request);
					dep.loc = expr.loc;
					parser.state.module.addDependency(dep);
					return dep;
				});
				if (dependencies.length > 0) {
					const dep = new HarmonyAcceptDependency(
						expr.range,
						dependencies,
						false
					);
					dep.loc = expr.loc;
					parser.state.module.addDependency(dep);
				}
			}
		);
	}
};

module.exports.harmonySpecifierTag = harmonySpecifierTag;
