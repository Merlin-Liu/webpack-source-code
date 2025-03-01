/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const { SyncWaterfallHook, SyncHook } = require("tapable");
const {
	ConcatSource,
	OriginalSource,
	PrefixSource,
	RawSource
} = require("webpack-sources");
const Compilation = require("../Compilation");
const { tryRunOrWebpackError } = require("../HookWebpackError");
const HotUpdateChunk = require("../HotUpdateChunk");
const RuntimeGlobals = require("../RuntimeGlobals");
const Template = require("../Template");
const { compareModulesByIdentifier } = require("../util/comparators");
const createHash = require("../util/createHash");
const JavascriptGenerator = require("./JavascriptGenerator");
const JavascriptParser = require("./JavascriptParser");

/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("../Chunk")} Chunk */
/** @typedef {import("../ChunkGraph")} ChunkGraph */
/** @typedef {import("../Compilation").ChunkHashContext} ChunkHashContext */
/** @typedef {import("../Compiler")} Compiler */
/** @typedef {import("../DependencyTemplates")} DependencyTemplates */
/** @typedef {import("../Module")} Module */
/** @typedef {import("../Module").CodeGenerationResult} CodeGenerationResult */
/** @typedef {import("../ModuleGraph")} ModuleGraph */
/** @typedef {import("../RuntimeTemplate")} RuntimeTemplate */
/** @typedef {import("../util/Hash")} Hash */

/**
 * @template T
 * @param {Iterable<T>} iterable iterable
 * @param {function(T): boolean} filter predicate
 * @returns {boolean} true, if some items match the filter predicate
 */
const someInIterable = (iterable, filter) => {
	for (const item of iterable) {
		if (filter(item)) return true;
	}
	return false;
};

/**
 * @param {Chunk} chunk a chunk
 * @param {ChunkGraph} chunkGraph the chunk graph
 * @returns {boolean} true, when a JS file is needed for this chunk
 */
const chunkHasJs = (chunk, chunkGraph) => {
	if (chunkGraph.getNumberOfEntryModules(chunk) > 0) return true;

	return chunkGraph.getChunkModulesIterableBySourceType(chunk, "javascript")
		? true
		: false;
};

/**
 * @typedef {Object} RenderContext
 * @property {Chunk} chunk the chunk
 * @property {DependencyTemplates} dependencyTemplates the dependency templates
 * @property {RuntimeTemplate} runtimeTemplate the runtime template
 * @property {ModuleGraph} moduleGraph the module graph
 * @property {ChunkGraph} chunkGraph the chunk graph
 * @property {Map<Module, CodeGenerationResult>} codeGenerationResults results of code generation
 */

/**
 * @typedef {Object} MainRenderContext
 * @property {Chunk} chunk the chunk
 * @property {DependencyTemplates} dependencyTemplates the dependency templates
 * @property {RuntimeTemplate} runtimeTemplate the runtime template
 * @property {ModuleGraph} moduleGraph the module graph
 * @property {ChunkGraph} chunkGraph the chunk graph
 * @property {Map<Module, CodeGenerationResult>} codeGenerationResults results of code generation
 * @property {string} hash hash to be used for render call
 */

/**
 * @typedef {Object} RenderBootstrapContext
 * @property {Chunk} chunk the chunk
 * @property {RuntimeTemplate} runtimeTemplate the runtime template
 * @property {ModuleGraph} moduleGraph the module graph
 * @property {ChunkGraph} chunkGraph the chunk graph
 * @property {string} hash hash to be used for render call
 */

/**
 * @typedef {Object} CompilationHooks
 * @property {SyncWaterfallHook<[Source, Module, RenderContext]>} renderModuleContent
 * @property {SyncWaterfallHook<[Source, Module, RenderContext]>} renderModuleContainer
 * @property {SyncWaterfallHook<[Source, Module, RenderContext]>} renderModulePackage
 * @property {SyncWaterfallHook<[Source, RenderContext]>} renderChunk
 * @property {SyncWaterfallHook<[Source, RenderContext]>} renderMain
 * @property {SyncWaterfallHook<[Source, RenderContext]>} render
 * @property {SyncWaterfallHook<[string, RenderBootstrapContext]>} renderRequire
 * @property {SyncHook<[Chunk, Hash, ChunkHashContext]>} chunkHash
 */

/** @type {WeakMap<Compilation, CompilationHooks>} */
const compilationHooksMap = new WeakMap();

class JavascriptModulesPlugin {
	/**
	 * @param {Compilation} compilation the compilation
	 * @returns {CompilationHooks} the attached hooks
	 */
	static getCompilationHooks(compilation) {
		if (!(compilation instanceof Compilation)) {
			throw new TypeError(
				"The 'compilation' argument must be an instance of Compilation"
			);
		}
		let hooks = compilationHooksMap.get(compilation);
		if (hooks === undefined) {
			hooks = {
				renderModuleContent: new SyncWaterfallHook([
					"source",
					"module",
					"renderContext"
				]),
				renderModuleContainer: new SyncWaterfallHook([
					"source",
					"module",
					"renderContext"
				]),
				renderModulePackage: new SyncWaterfallHook([
					"source",
					"module",
					"renderContext"
				]),
				render: new SyncWaterfallHook(["source", "renderContext"]),
				renderChunk: new SyncWaterfallHook(["source", "renderContext"]),
				renderMain: new SyncWaterfallHook(["source", "renderContext"]),
				renderRequire: new SyncWaterfallHook(["code", "renderContext"]),
				chunkHash: new SyncHook(["chunk", "hash", "context"])
			};
			compilationHooksMap.set(compilation, hooks);
		}
		return hooks;
	}

	constructor(options = {}) {
		this.options = options;
	}

	/**
	 * @param {Compiler} compiler webpack compiler
	 * @returns {void}
	 */
	apply(compiler) {
		compiler.hooks.compilation.tap(
			"JavascriptModulesPlugin",
			(compilation, { normalModuleFactory }) => {
				const hooks = JavascriptModulesPlugin.getCompilationHooks(compilation);
				normalModuleFactory.hooks.createParser
					.for("javascript/auto")
					.tap("JavascriptModulesPlugin", options => {
						return new JavascriptParser(options, "auto");
					});
				normalModuleFactory.hooks.createParser
					.for("javascript/dynamic")
					.tap("JavascriptModulesPlugin", options => {
						return new JavascriptParser(options, "script");
					});
				normalModuleFactory.hooks.createParser
					.for("javascript/esm")
					.tap("JavascriptModulesPlugin", options => {
						return new JavascriptParser(options, "module");
					});
				normalModuleFactory.hooks.createGenerator
					.for("javascript/auto")
					.tap("JavascriptModulesPlugin", () => {
						return new JavascriptGenerator();
					});
				normalModuleFactory.hooks.createGenerator
					.for("javascript/dynamic")
					.tap("JavascriptModulesPlugin", () => {
						return new JavascriptGenerator();
					});
				normalModuleFactory.hooks.createGenerator
					.for("javascript/esm")
					.tap("JavascriptModulesPlugin", () => {
						return new JavascriptGenerator();
					});

				compilation.hooks.renderManifest.tap("JavascriptModulesPlugin", (result, options) => {
					consola.info('2⃣️ 6⃣️  `renderManifest`钩子执行，生成chunk的`manifest`，位置是`lib/javascript/JavascriptModulesPlugin`')

					const { hash, chunk, chunkGraph, moduleGraph, runtimeTemplate, dependencyTemplates, outputOptions, codeGenerationResults } = options;

					const hotUpdateChunk = chunk instanceof HotUpdateChunk ? chunk : null;

					let render;
					let filenameTemplate;
					if (hotUpdateChunk) {
						filenameTemplate = outputOptions.hotUpdateChunkFilename;

						render = () => this.renderChunk({chunk, dependencyTemplates, runtimeTemplate, moduleGraph, chunkGraph, codeGenerationResults}, hooks);
					}
					else if (chunk.hasRuntime()) {
						filenameTemplate = chunk.filenameTemplate || outputOptions.filename;

						render = () => this.renderMain({hash, chunk, dependencyTemplates, runtimeTemplate, moduleGraph, chunkGraph, codeGenerationResults}, hooks);
					}
					else {
						if (!chunkHasJs(chunk, chunkGraph)) {
							return result;
						}

						if (chunk.filenameTemplate) {
							filenameTemplate = chunk.filenameTemplate;
						}
						else if (chunk.isOnlyInitial()) {
							filenameTemplate = outputOptions.filename;
						}
						else {
							filenameTemplate = outputOptions.chunkFilename;
						}

						render = () => this.renderChunk({chunk, dependencyTemplates, runtimeTemplate, moduleGraph, chunkGraph, codeGenerationResults}, hooks);
					}

					result.push({
						render,
						filenameTemplate,
						pathOptions: {hash, chunk, contentHashType: "javascript"},
						identifier: hotUpdateChunk ? `hotupdatechunk${chunk.id}` : `chunk${chunk.id}`,
						hash: chunk.hash
					});

					return result;
				});

				compilation.hooks.chunkHash.tap(
					"JavascriptModulesPlugin",
					(chunk, hash, context) => {
						hooks.chunkHash.call(chunk, hash, context);
						if (chunk.hasRuntime()) {
							const bootstrap = this.renderBootstrap(
								{
									hash: "0000",
									chunk,
									chunkGraph: context.chunkGraph,
									moduleGraph: context.moduleGraph,
									runtimeTemplate: context.runtimeTemplate
								},
								hooks
							);
							for (const key of Object.keys(bootstrap)) {
								hash.update(key);
								if (Array.isArray(bootstrap[key])) {
									for (const line of bootstrap[key]) {
										hash.update(line);
									}
								} else {
									hash.update(JSON.stringify(bootstrap[key]));
								}
							}
						}
					}
				);
				compilation.hooks.contentHash.tap("JavascriptModulesPlugin", chunk => {
					const {
						chunkGraph,
						moduleGraph,
						runtimeTemplate,
						outputOptions: {
							hashSalt,
							hashDigest,
							hashDigestLength,
							hashFunction
						}
					} = compilation;
					const hotUpdateChunk = chunk instanceof HotUpdateChunk ? chunk : null;
					const hash = createHash(hashFunction);
					if (hashSalt) hash.update(hashSalt);
					hash.update(`${chunk.id} `);
					hash.update(chunk.ids ? chunk.ids.join(",") : "");
					hooks.chunkHash.call(chunk, hash, {
						chunkGraph,
						moduleGraph,
						runtimeTemplate
					});
					const modules = chunkGraph.getOrderedChunkModulesIterableBySourceType(
						chunk,
						"javascript",
						compareModulesByIdentifier
					);
					if (modules) {
						for (const m of modules) {
							hash.update(chunkGraph.getModuleHash(m));
						}
					}
					if (hotUpdateChunk) {
						hash.update(JSON.stringify(hotUpdateChunk.removedModules));
					}
					const digest = /** @type {string} */ (hash.digest(hashDigest));
					chunk.contentHash.javascript = digest.substr(0, hashDigestLength);
				});
			}
		);
	}

	/**
	 * @param {Module} module the rendered module
	 * @param {RenderContext} renderContext options object
	 * @param {CompilationHooks} hooks hooks
	 * @param {boolean | "strict"} factory true: renders as factory method, "strict": renders as factory method already in strict scope, false: pure module content
	 * @returns {Source} the newly generated source from rendering
	 */
	renderModule(module, renderContext, hooks, factory) {
		const {
			chunkGraph,
			runtimeTemplate,
			codeGenerationResults
		} = renderContext;
		try {
			const moduleSource = codeGenerationResults
				.get(module)
				.sources.get("javascript");
			if (!moduleSource) return null;
			const moduleSourcePostContent = tryRunOrWebpackError(
				() =>
					hooks.renderModuleContent.call(moduleSource, module, renderContext),
				"JavascriptModulesPlugin.getCompilationHooks().renderModuleContent"
			);
			let moduleSourcePostContainer;
			if (factory) {
				const source = new ConcatSource();
				const args = [];
				const runtimeRequirements = chunkGraph.getModuleRuntimeRequirements(
					module
				);
				const needModule = runtimeRequirements.has(RuntimeGlobals.module);
				const needExports = runtimeRequirements.has(RuntimeGlobals.exports);
				const needRequire =
					runtimeRequirements.has(RuntimeGlobals.require) ||
					runtimeRequirements.has(RuntimeGlobals.requireScope);
				const needThisAsExports = runtimeRequirements.has(
					RuntimeGlobals.thisAsExports
				);
				if (needExports || needRequire || needModule)
					args.push(
						needModule
							? module.moduleArgument
							: "__unused_webpack_" + module.moduleArgument
					);
				if (needExports || needRequire)
					args.push(
						needExports
							? module.exportsArgument
							: "__unused_webpack_" + module.exportsArgument
					);
				if (needRequire) args.push("__webpack_require__");
				if (!needThisAsExports && runtimeTemplate.supportsArrowFunction()) {
					source.add("/***/ ((" + args.join(", ") + ") => {\n\n");
				} else {
					source.add("/***/ (function(" + args.join(", ") + ") {\n\n");
				}
				if (module.buildInfo.strict && factory !== "strict") {
					source.add('"use strict";\n');
				}
				source.add(moduleSourcePostContent);
				source.add("\n\n/***/ })");
				moduleSourcePostContainer = tryRunOrWebpackError(
					() => hooks.renderModuleContainer.call(source, module, renderContext),
					"JavascriptModulesPlugin.getCompilationHooks().renderModuleContainer"
				);
			} else {
				moduleSourcePostContainer = moduleSourcePostContent;
			}
			return tryRunOrWebpackError(
				() =>
					hooks.renderModulePackage.call(
						moduleSourcePostContainer,
						module,
						renderContext
					),
				"JavascriptModulesPlugin.getCompilationHooks().renderModulePackage"
			);
		} catch (e) {
			e.module = module;
			throw e;
		}
	}

	/**
	 * @param {RenderContext} renderContext the render context
	 * @param {CompilationHooks} hooks hooks
	 * @returns {Source} the rendered source
	 */
	renderChunk(renderContext, hooks) {
		const { chunk, chunkGraph } = renderContext;
		const modules = chunkGraph.getOrderedChunkModulesIterableBySourceType(
			chunk,
			"javascript",
			compareModulesByIdentifier
		);
		const moduleSources =
			Template.renderChunkModules(
				renderContext,
				modules ? Array.from(modules) : [],
				module => this.renderModule(module, renderContext, hooks, true)
			) || new RawSource("{}");
		let source = tryRunOrWebpackError(
			() => hooks.renderChunk.call(moduleSources, renderContext),
			"JavascriptModulesPlugin.getCompilationHooks().renderChunk"
		);
		source = tryRunOrWebpackError(
			() => hooks.render.call(source, renderContext),
			"JavascriptModulesPlugin.getCompilationHooks().render"
		);
		chunk.rendered = true;
		return new ConcatSource(source, ";");
	}

	/**
	 * @param {MainRenderContext} renderContext options object
	 * @param {CompilationHooks} hooks hooks
	 * @returns {Source} the newly generated source from rendering
	 */
	renderMain(renderContext, hooks) {
		consola.info('2⃣️ 9⃣️  调用`JavascriptModulesPlugin`的`renderMain`方法渲染`Chunk`，生成`soucre`')
		const { chunk, chunkGraph, runtimeTemplate } = renderContext;

		const runtimeRequirements = chunkGraph.getTreeRuntimeRequirements(chunk);
		const iife = runtimeTemplate.isIIFE();

		const bootstrap = this.renderBootstrap(renderContext, hooks);

		const allModules = Array.from(
			chunkGraph.getOrderedChunkModulesIterableBySourceType(chunk, "javascript", compareModulesByIdentifier) || []
		);
		const allStrict = allModules.every(m => m.buildInfo.strict);

		let inlinedModules;
		if (bootstrap.allowInlineStartup) {
			inlinedModules = new Set(chunkGraph.getChunkEntryModulesIterable(chunk));
		}

		let source = new ConcatSource();
		let prefix;

		// 将最终代码包装成立即执行函数
		if (iife) {
			if (runtimeTemplate.supportsConst()) {
				source.add("/******/ (() => { // webpackBootstrap\n");
			}
			else {
				source.add("/******/ (function() { // webpackBootstrap\n");
			}
			prefix = "/******/ \t";
		}
		else {
			prefix = "/******/ ";
		}

		// 严格模式
		if (allStrict) {
			source.add(prefix + '"use strict";\n');
		}

		// 生成chunkModules的编译结果
		const chunkModules = Template.renderChunkModules(
			renderContext,
			inlinedModules ? allModules.filter(m => !inlinedModules.has(m)) : allModules,
			module => this.renderModule(module, renderContext, hooks, allStrict ? "strict" : true),
			prefix
		);
		if (chunkModules ||
			runtimeRequirements.has(RuntimeGlobals.moduleFactories) ||
			runtimeRequirements.has(RuntimeGlobals.moduleFactoriesAddOnly)
		) {
			source.add(prefix + "var __webpack_modules__ = (");
			source.add(chunkModules || "{}");
			source.add(");\n");
			source.add("/************************************************************************/\n");
		}

		if (bootstrap.header.length > 0) {
			source.add(
				new PrefixSource(
					prefix,
					new OriginalSource(Template.asString(bootstrap.header) + "\n", "webpack/bootstrap")
				)
			);
			source.add("/************************************************************************/\n");
		}

		const runtimeModules = renderContext.chunkGraph.getChunkRuntimeModulesInOrder(chunk);

		if (runtimeModules.length > 0) {
			source.add(
				new PrefixSource(prefix, Template.renderRuntimeModules(runtimeModules, renderContext))
			);
			source.add("/************************************************************************/\n");
		}
		if (inlinedModules) {
			for (const m of inlinedModules) {
				const renderedModule = this.renderModule(m, renderContext, hooks, false);
				if (renderedModule) {
					const innerStrict = !allStrict && m.buildInfo.strict;
					const iife = innerStrict || inlinedModules.size > 1 || chunkModules;
					if (iife) {
						source.add("!function() {\n");
						if (innerStrict) source.add('"use strict";\n');
						source.add(renderedModule);
						source.add("\n}();\n");
					}
					else {
						source.add(renderedModule);
						source.add("\n");
					}
				}
			}
		}
		else {
			source.add(
				new PrefixSource(
					prefix,
					new OriginalSource(Template.asString(bootstrap.startup) + "\n", "webpack/startup")
				)
			);
		}
		if (iife) {
			source.add("/******/ })()\n");
		}

		/** @type {Source} */
		let finalSource = tryRunOrWebpackError(
			() => hooks.renderMain.call(source, renderContext),
			"JavascriptModulesPlugin.getCompilationHooks().renderMain"
		);

		if (!finalSource) {
			throw new Error("JavascriptModulesPlugin error: JavascriptModulesPlugin.getCompilationHooks().renderMain plugins should return something");
		}
		finalSource = tryRunOrWebpackError(
			() => hooks.render.call(finalSource, renderContext),
			"JavascriptModulesPlugin.getCompilationHooks().render"
		);

		if (!finalSource) {
			throw new Error("JavascriptModulesPlugin error: JavascriptModulesPlugin.getCompilationHooks().render plugins should return something");
		}
		chunk.rendered = true;

		return iife ? new ConcatSource(finalSource, ";") : finalSource;
	}

	/**
	 * @param {RenderBootstrapContext} renderContext options object
	 * @param {CompilationHooks} hooks hooks
	 * @returns {{ header: string[], startup: string[], allowInlineStartup: boolean }} the generated source of the bootstrap code
	 */
	renderBootstrap(renderContext, hooks) {
		const { chunkGraph, moduleGraph, chunk, runtimeTemplate } = renderContext;

		const runtimeRequirements = chunkGraph.getTreeRuntimeRequirements(chunk);

		const requireFunction = runtimeRequirements.has(RuntimeGlobals.require);
		const moduleCache = runtimeRequirements.has(RuntimeGlobals.moduleCache);
		const moduleFactories = runtimeRequirements.has(RuntimeGlobals.moduleFactories);
		const moduleUsed = runtimeRequirements.has(RuntimeGlobals.module);
		const exportsUsed = runtimeRequirements.has(RuntimeGlobals.exports);
		const requireScopeUsed = runtimeRequirements.has(RuntimeGlobals.requireScope);
		const interceptModuleExecution = runtimeRequirements.has(RuntimeGlobals.interceptModuleExecution);
		const returnExportsFromRuntime = runtimeRequirements.has(RuntimeGlobals.returnExportsFromRuntime);

		const useRequire =
			requireFunction ||
			interceptModuleExecution ||
			returnExportsFromRuntime ||
			moduleUsed ||
			exportsUsed;

		const result = {
			header: [],
			startup: [],
			allowInlineStartup: true
		};

		let buf = result.header;
		let startup = result.startup;

		if (result.allowInlineStartup && moduleFactories) {
			startup.push("// module factories are used so entry inlining is disabled");
			result.allowInlineStartup = false;
		}
		if (result.allowInlineStartup && moduleCache) {
			startup.push("// module cache are used so entry inlining is disabled");
			result.allowInlineStartup = false;
		}
		if (result.allowInlineStartup && interceptModuleExecution) {
			startup.push("// module execution is intercepted so entry inlining is disabled");
			result.allowInlineStartup = false;
		}
		if (result.allowInlineStartup && returnExportsFromRuntime) {
			startup.push("// module exports must be returned from runtime so entry inlining is disabled");
			result.allowInlineStartup = false;
		}

		if (useRequire || moduleCache) {
			buf.push("// The module cache");
			buf.push("var __webpack_module_cache__ = {};");
			buf.push("");
		}

		if (useRequire) {
			buf.push("// The require function");
			buf.push(`function __webpack_require__(moduleId) {`);
			buf.push(Template.indent(this.renderRequire(renderContext, hooks)));
			buf.push("}");
			buf.push("");
		} else if (runtimeRequirements.has(RuntimeGlobals.requireScope)) {
			buf.push("// The require scope");
			buf.push("var __webpack_require__ = {};");
			buf.push("");
		}

		if (
			moduleFactories ||
			runtimeRequirements.has(RuntimeGlobals.moduleFactoriesAddOnly)
		) {
			buf.push("// expose the modules object (__webpack_modules__)");
			buf.push(`${RuntimeGlobals.moduleFactories} = __webpack_modules__;`);
			buf.push("");
		}

		if (moduleCache) {
			buf.push("// expose the module cache");
			buf.push(`${RuntimeGlobals.moduleCache} = __webpack_module_cache__;`);
			buf.push("");
		}

		if (interceptModuleExecution) {
			buf.push("// expose the module execution interceptor");
			buf.push(`${RuntimeGlobals.interceptModuleExecution} = [];`);
			buf.push("");
		}

		if (!runtimeRequirements.has(RuntimeGlobals.startupNoDefault)) {
			if (chunkGraph.getNumberOfEntryModules(chunk) > 0) {
				/** @type {string[]} */
				const buf2 = [];
				const runtimeRequirements = chunkGraph.getTreeRuntimeRequirements(
					chunk
				);
				buf2.push(
					returnExportsFromRuntime
						? "// Load entry module and return exports"
						: "// Load entry module"
				);
				let i = chunkGraph.getNumberOfEntryModules(chunk);
				for (const entryModule of chunkGraph.getChunkEntryModulesIterable(
					chunk
				)) {
					if (
						result.allowInlineStartup &&
						someInIterable(
							moduleGraph.getIncomingConnections(entryModule),
							c => c.originModule && c.active
						)
					) {
						buf2.push("// This entry module is referenced by other modules so it can't be inlined");
						result.allowInlineStartup = false;
					}
					const mayReturn =
						--i === 0 && returnExportsFromRuntime ? "return " : "";
					const moduleId = chunkGraph.getModuleId(entryModule);
					const entryRuntimeRequirements = chunkGraph.getModuleRuntimeRequirements(entryModule);
					let moduleIdExpr = JSON.stringify(moduleId);
					if (runtimeRequirements.has(RuntimeGlobals.entryModuleId)) {
						moduleIdExpr = `${RuntimeGlobals.entryModuleId} = ${moduleIdExpr}`;
					}
					if (useRequire) {
						buf2.push(`${mayReturn}__webpack_require__(${moduleIdExpr});`);
						if (result.allowInlineStartup) {
							if (entryRuntimeRequirements.has(RuntimeGlobals.module)) {
								result.allowInlineStartup = false;
								buf2.push("// This entry module used 'module' so it can't be inlined");
							} else if (entryRuntimeRequirements.has(RuntimeGlobals.exports)) {
								buf2.push("// This entry module used 'exports' so it can't be inlined");
								result.allowInlineStartup = false;
							}
						}
					} else if (requireScopeUsed) {
						buf2.push(`__webpack_modules__[${moduleIdExpr}](0, 0, __webpack_require__);`);
					} else {
						buf2.push(`__webpack_modules__[${moduleIdExpr}]();`);
					}
				}
				if (runtimeRequirements.has(RuntimeGlobals.startup)) {
					result.allowInlineStartup = false;
					buf.push(
						Template.asString([
							"// the startup function",
							`${RuntimeGlobals.startup} = ${runtimeTemplate.basicFunction("", buf2)};`
						])
					);
					buf.push("");
					startup.push("// run startup");
					startup.push(`return ${RuntimeGlobals.startup}();`);
				} else {
					startup.push(
						Template.asString(["// startup", Template.asString(buf2)])
					);
				}
			} else if (runtimeRequirements.has(RuntimeGlobals.startup)) {
				buf.push(
					Template.asString([
						"// the startup function",
						"// It's empty as no entry modules are in this chunk",
						`${RuntimeGlobals.startup} = ${runtimeTemplate.basicFunction("", "")}`
					])
				);
				buf.push("");
			}
		} else if (runtimeRequirements.has(RuntimeGlobals.startup)) {
			result.allowInlineStartup = false;
			startup.push("// run startup");
			startup.push(`return ${RuntimeGlobals.startup}();`);
		}
		return result;
	}

	/**
	 * @param {RenderBootstrapContext} renderContext options object
	 * @param {CompilationHooks} hooks hooks
	 * @returns {string} the generated source of the require function
	 */
	renderRequire(renderContext, hooks) {
		const {
			chunk,
			chunkGraph,
			runtimeTemplate: { outputOptions }
		} = renderContext;
		const runtimeRequirements = chunkGraph.getTreeRuntimeRequirements(chunk);
		const moduleExecution = runtimeRequirements.has(
			RuntimeGlobals.interceptModuleExecution
		)
			? Template.asString([
					"var execOptions = { id: moduleId, module: module, factory: __webpack_modules__[moduleId], require: __webpack_require__ };",
					`${RuntimeGlobals.interceptModuleExecution}.forEach(function(handler) { handler(execOptions); });`,
					"module = execOptions.module;",
					"execOptions.factory.call(module.exports, module, module.exports, execOptions.require);"
			  ])
			: runtimeRequirements.has(RuntimeGlobals.thisAsExports)
			? Template.asString([
					"__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);"
			  ])
			: Template.asString([
					"__webpack_modules__[moduleId](module, module.exports, __webpack_require__);"
			  ]);
		const content = Template.asString([
			"// Check if module is in cache",
			"if(__webpack_module_cache__[moduleId]) {",
			Template.indent("return __webpack_module_cache__[moduleId].exports;"),
			"}",
			"// Create a new module (and put it into the cache)",
			"var module = __webpack_module_cache__[moduleId] = {",
			Template.indent(["i: moduleId,", "l: false,", "exports: {}"]),
			"};",
			"",
			outputOptions.strictModuleExceptionHandling
				? Template.asString([
						"// Execute the module function",
						"var threw = true;",
						"try {",
						Template.indent([moduleExecution, "threw = false;"]),
						"} finally {",
						Template.indent([
							"if(threw) delete __webpack_module_cache__[moduleId];"
						]),
						"}"
				  ])
				: Template.asString([
						"// Execute the module function",
						moduleExecution
				  ]),
			"",
			"// Flag the module as loaded",
			"module.l = true;",
			"",
			"// Return the exports of the module",
			"return module.exports;"
		]);
		return tryRunOrWebpackError(
			() => hooks.renderRequire.call(content, renderContext),
			"JavascriptModulesPlugin.getCompilationHooks().renderRequire"
		);
	}
}

module.exports = JavascriptModulesPlugin;
module.exports.chunkHasJs = chunkHasJs;
