/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const consola = require('consola')
const asyncLib = require("neo-async");
const {
	AsyncSeriesBailHook,
	SyncWaterfallHook,
	SyncBailHook,
	SyncHook,
	HookMap
} = require("tapable");
const Module = require("./Module");
const ModuleFactory = require("./ModuleFactory");
const NormalModule = require("./NormalModule");
const RawModule = require("./RawModule");
const BasicEffectRulePlugin = require("./rules/BasicEffectRulePlugin");
const BasicMatcherRulePlugin = require("./rules/BasicMatcherRulePlugin");
const RuleSetCompiler = require("./rules/RuleSetCompiler");
const UseEffectRulePlugin = require("./rules/UseEffectRulePlugin");
const LazySet = require("./util/LazySet");
const { cachedCleverMerge } = require("./util/cleverMerge");
const { join } = require("./util/fs");

/** @typedef {import("./Generator")} Generator */
/** @typedef {import("./ModuleFactory").ModuleFactoryCreateData} ModuleFactoryCreateData */
/** @typedef {import("./ModuleFactory").ModuleFactoryResult} ModuleFactoryResult */
/** @typedef {import("./dependencies/ModuleDependency")} ModuleDependency */

/**
 * @typedef {Object} ResolveData
 * @property {ModuleFactoryCreateData["contextInfo"]} contextInfo
 * @property {ModuleFactoryCreateData["resolveOptions"]} resolveOptions
 * @property {string} context
 * @property {string} request
 * @property {ModuleDependency[]} dependencies
 * @property {Object} createData
 * @property {LazySet<string>} fileDependencies
 * @property {LazySet<string>} missingDependencies
 * @property {LazySet<string>} contextDependencies
 */

const EMPTY_OBJECT = {};

const MATCH_RESOURCE_REGEX = /^([^!]+)!=!/;

const loaderToIdent = data => {
	if (!data.options) {
		return data.loader;
	}
	if (typeof data.options === "string") {
		return data.loader + "?" + data.options;
	}
	if (typeof data.options !== "object") {
		throw new Error("loader options must be string or object");
	}
	if (data.ident) {
		return data.loader + "??" + data.ident;
	}
	return data.loader + "?" + JSON.stringify(data.options);
};

const stringifyLoadersAndResource = (loaders, resource) => {
	let str = "";
	for (const loader of loaders) {
		str += loaderToIdent(loader) + "!";
	}
	return str + resource;
};

const identToLoaderRequest = resultString => {
	const idx = resultString.indexOf("?");
	if (idx >= 0) {
		const loader = resultString.substr(0, idx);
		const options = resultString.substr(idx + 1);
		return {
			loader,
			options
		};
	} else {
		return {
			loader: resultString,
			options: undefined
		};
	}
};

const needCalls = (times, callback) => {
	return err => {
		if (--times === 0) {
			return callback(err);
		}
		if (err && times > 0) {
			times = NaN;
			return callback(err);
		}
	};
};

// TODO webpack 6 remove
const deprecationChangedHookMessage = name => `NormalModuleFactory.${name} is no longer a waterfall hook, but a bailing hook instead. ` + "Do not return the passed object, but modify it instead. Returning false will ignore the request and results in no module created.";

const dependencyCache = new WeakMap();

const ruleSetCompiler = new RuleSetCompiler([
	new BasicMatcherRulePlugin("test", "resource"),
	new BasicMatcherRulePlugin("include", "resource"),
	new BasicMatcherRulePlugin("exclude", "resource", true),
	new BasicMatcherRulePlugin("resource"),
	new BasicMatcherRulePlugin("resourceQuery"),
	new BasicMatcherRulePlugin("realResource"),
	new BasicMatcherRulePlugin("issuer"),
	new BasicMatcherRulePlugin("compiler"),
	new BasicEffectRulePlugin("type"),
	new BasicEffectRulePlugin("sideEffects"),
	new BasicEffectRulePlugin("parser"),
	new BasicEffectRulePlugin("resolve"),
	new BasicEffectRulePlugin("generator"),
	new UseEffectRulePlugin()
]);

class NormalModuleFactory extends ModuleFactory {
	constructor({ context, fs, resolverFactory, options }) {
		super();
		this.hooks = Object.freeze({
			/** @type {AsyncSeriesBailHook<[ResolveData], TODO>} */
			resolve: new AsyncSeriesBailHook(["resolveData"]),

			/** @type {AsyncSeriesBailHook<[ResolveData], TODO>} */
			// 字面意思：因式分解
			factorize: new AsyncSeriesBailHook(["resolveData"]),
			/** @type {AsyncSeriesBailHook<[ResolveData], TODO>} */
			beforeResolve: new AsyncSeriesBailHook(["resolveData"]),
			/** @type {AsyncSeriesBailHook<[ResolveData], TODO>} */
			afterResolve: new AsyncSeriesBailHook(["resolveData"]),
			/** @type {SyncBailHook<[ResolveData], TODO>} */
			createModule: new SyncBailHook(["resolveData"]),
			/** @type {SyncWaterfallHook<[Module, ResolveData["createData"], ResolveData], TODO>} */
			module: new SyncWaterfallHook(["module", "createData", "resolveData"]),
			createParser: new HookMap(() => new SyncBailHook(["parserOptions"])),
			parser: new HookMap(() => new SyncHook(["parser", "parserOptions"])),
			createGenerator: new HookMap(() => new SyncBailHook(["generatorOptions"])),
			generator: new HookMap(() => new SyncHook(["generator", "generatorOptions"]))
		});

		this.resolverFactory = resolverFactory;
		this.ruleSet = ruleSetCompiler.compile([{rules: options.defaultRules}, {rules: options.rules}]);
		this.unsafeCache = !!options.unsafeCache;
		this.cachePredicate = typeof options.unsafeCache === "function" ? options.unsafeCache : () => true;
		this.context = context || "";
		this.fs = fs;

		/**
		 * @type {Map<string, WeakMap<Object, TODO>>}
		 */
		this.parserCache = new Map();

		/**
		 * @type {Map<string, WeakMap<Object, Generator>>}
		 */
		this.generatorCache = new Map();
		this.hooks.factorize.tapAsync(
			/** @type {TODO} */ ({name: "NormalModuleFactory", stage: 100}),
			(resolveData, callback) => {
				this.hooks.resolve.callAsync(resolveData, (err, result) => {
					if (err) return callback(err);

					// Ignored
					if (result === false) return callback();

					// direct module
					if (result instanceof Module) return callback(null, result);

					if (typeof result === "object") throw new Error(deprecationChangedHookMessage("resolve") + " Returning a Module object will result in this module used as result.");

					this.hooks.afterResolve.callAsync(resolveData, (err, result) => {
						if (err) return callback(err);

						if (typeof result === "object") throw new Error(deprecationChangedHookMessage("afterResolve"));

						// Ignored
						if (result === false) return callback();

						const createData = resolveData.createData;

						let createdModule = this.hooks.createModule.call(createData);
						if (!createdModule) {
							if (!resolveData.request) {
								return callback(new Error("Empty dependency (no request)"));
							}

							createdModule = new NormalModule(createData);
						}

						createdModule = this.hooks.module.call(createdModule, createData, resolveData);

						return callback(null, createdModule);
					});
				});
			}
		);
		this.hooks.resolve.tapAsync(
			/** @type {TODO} */ ({
				name: "NormalModuleFactory",
				stage: 100
			}),
			(data, callback) => {
				const {
					contextInfo,
					context,
					request,
					resolveOptions,
					fileDependencies,
					missingDependencies,
					contextDependencies
				} = data;

				const loaderResolver = this.getResolver("loader");
				const normalResolver = this.getResolver("normal", resolveOptions);

				/** @type {string} */
				let matchResource = undefined;
				/** @type {string} */
				let requestWithoutMatchResource = request;
				const matchResourceMatch = MATCH_RESOURCE_REGEX.exec(request);
				if (matchResourceMatch) {
					matchResource = matchResourceMatch[1];
					if (matchResource.charCodeAt(0) === 46) {
						// 46 === ".", 47 === "/"
						const secondChar = matchResource.charCodeAt(1);
						if (secondChar === 47 || (secondChar === 46 && matchResource.charCodeAt(2) === 47)) {
							// if matchResources startsWith ../ or ./
							matchResource = join(this.fs, context, matchResource);
						}
					}
					requestWithoutMatchResource = request.substr(matchResourceMatch[0].length);
				}

				const firstChar = requestWithoutMatchResource.charCodeAt(0);
				const secondChar = requestWithoutMatchResource.charCodeAt(1);
				const noPreAutoLoaders = firstChar === 45 && secondChar === 33; // startsWith "-!"
				const noAutoLoaders = noPreAutoLoaders || firstChar === 33; // startsWith "!"
				const noPrePostAutoLoaders = firstChar === 33 && secondChar === 33; // startsWith "!!";
				const rawElements = requestWithoutMatchResource.slice(noPreAutoLoaders || noPrePostAutoLoaders ? 2 : noAutoLoaders ? 1 : 0).split(/!+/);
				const unresolvedResource = rawElements.pop();
				const elements = rawElements.map(identToLoaderRequest);

				const resolveContext = {
					fileDependencies,
					missingDependencies,
					contextDependencies
				};

				/** @type {string | false} */
				let resource;
				let resourceResolveData;
				let loaders;

				const continueCallback = needCalls(2, err => {
					if (err) return callback(err);

					// translate option idents
					try {
						for (const item of loaders) {
							if (typeof item.options === "string" && item.options[0] === "?") {
								const ident = item.options.substr(1);
								if (ident === "[[missing ident]]") {
									throw new Error(
										"No ident is provided by referenced loader. " +
											"When using a function for Rule.use in config you need to " +
											"provide an 'ident' property for referenced loader options."
									);
								}
								item.options = this.ruleSet.references.get(ident);
								if (item.options === undefined) {
									throw new Error(
										"Invalid ident is provided by referenced loader"
									);
								}
								item.ident = ident;
							}
						}
					} catch (e) {
						return callback(e);
					}

					if (resource === false) {
						// ignored
						return callback(
							null,
							new RawModule(
								"/* (ignored) */",
								`ignored|${request}`,
								`${request} (ignored)`
							)
						);
					}

					const userRequest =
						(matchResource !== undefined ? `${matchResource}!=!` : "") +
						stringifyLoadersAndResource(loaders, resource);

					let resourcePath =
						matchResource !== undefined ? matchResource : resource;
					let resourceQuery = "";
					const queryIndex = resourcePath.indexOf("?");
					if (queryIndex >= 0) {
						resourceQuery = resourcePath.substr(queryIndex);
						resourcePath = resourcePath.substr(0, queryIndex);
					}

					const result = this.ruleSet.exec({
						resource: resourcePath,
						realResource:
							matchResource !== undefined
								? resource.replace(/\?.*/, "")
								: resourcePath,
						resourceQuery,
						issuer: contextInfo.issuer,
						compiler: contextInfo.compiler
					});
					const settings = {};
					const useLoadersPost = [];
					const useLoaders = [];
					const useLoadersPre = [];
					for (const r of result) {
						if (r.type === "use") {
							if (!noAutoLoaders && !noPrePostAutoLoaders) {
								useLoaders.push(r.value);
							}
						} else if (r.type === "use-post") {
							if (!noPrePostAutoLoaders) {
								useLoadersPost.push(r.value);
							}
						} else if (r.type === "use-pre") {
							if (!noPreAutoLoaders && !noPrePostAutoLoaders) {
								useLoadersPre.push(r.value);
							}
						} else if (
							typeof r.value === "object" &&
							r.value !== null &&
							typeof settings[r.type] === "object" &&
							settings[r.type] !== null
						) {
							settings[r.type] = cachedCleverMerge(settings[r.type], r.value);
						} else {
							settings[r.type] = r.value;
						}
					}

					let postLoaders, normalLoaders, preLoaders;

					const continueCallback = needCalls(3, err => {
						if (err) {
							return callback(err);
						}
						const allLoaders = postLoaders;
						if (matchResource === undefined) {
							for (const loader of loaders) allLoaders.push(loader);
							for (const loader of normalLoaders) allLoaders.push(loader);
						} else {
							for (const loader of normalLoaders) allLoaders.push(loader);
							for (const loader of loaders) allLoaders.push(loader);
						}
						for (const loader of preLoaders) allLoaders.push(loader);
						const type = settings.type;
						const resolveOptions = settings.resolve;
						Object.assign(data.createData, {
							request: stringifyLoadersAndResource(allLoaders, resource),
							userRequest,
							rawRequest: request,
							loaders: allLoaders,
							resource,
							matchResource,
							resourceResolveData,
							settings,
							type,
							parser: this.getParser(type, settings.parser),
							generator: this.getGenerator(type, settings.generator),
							resolveOptions
						});
						callback();
					});
					this.resolveRequestArray(
						contextInfo,
						this.context,
						useLoadersPost,
						loaderResolver,
						resolveContext,
						(err, result) => {
							postLoaders = result;
							continueCallback(err);
						}
					);
					this.resolveRequestArray(
						contextInfo,
						this.context,
						useLoaders,
						loaderResolver,
						resolveContext,
						(err, result) => {
							normalLoaders = result;
							continueCallback(err);
						}
					);
					this.resolveRequestArray(
						contextInfo,
						this.context,
						useLoadersPre,
						loaderResolver,
						resolveContext,
						(err, result) => {
							preLoaders = result;
							continueCallback(err);
						}
					);
				});

				this.resolveRequestArray(
					contextInfo,
					context,
					elements,
					loaderResolver,
					resolveContext,
					(err, result) => {
						if (err) return continueCallback(err);
						loaders = result;
						continueCallback();
					}
				);

				if (unresolvedResource === "" || unresolvedResource.charCodeAt(0) === 63) {
					// 63 === "?"
					resource = unresolvedResource;
					return continueCallback();
				}

				normalResolver.resolve(
					contextInfo,
					context,
					unresolvedResource,
					resolveContext,
					(err, resolvedResource, resolvedResourceResolveData) => {
						if (err) return continueCallback(err);
						resource = resolvedResource;
						resourceResolveData = resolvedResourceResolveData;
						continueCallback();
					}
				);
			}
		);
	}

	/**
	 * @param {ModuleFactoryCreateData} data data object
	 * @param {function(Error=, ModuleFactoryResult=): void} callback callback
	 * @returns {void}
	 */
	create(data, callback) {
		consola.info(`1⃣️ 3⃣️  执行\`NormalModuleFactory\`的\`create\`方法创建\`Module\`，所要创建的\`Module\`为\`${data.dependencies[0].request}\``)

		const dependencies = /** @type {ModuleDependency[]} */ (data.dependencies);
		if (this.unsafeCache) {
			const cacheEntry = dependencyCache.get(dependencies[0]);
			if (cacheEntry) return callback(null, cacheEntry);
		}

		const context = data.context || this.context;
		const resolveOptions = data.resolveOptions || EMPTY_OBJECT;
		const dependency = dependencies[0]; // 取dependencies第一位
		const request = dependency.request;
		const contextInfo = data.contextInfo;

		const fileDependencies = new LazySet();
		const missingDependencies = new LazySet();
		const contextDependencies = new LazySet();

		/** @type {ResolveData} */
		const resolveData = {
			contextInfo,
			resolveOptions,
			context,
			request,
			dependencies,
			fileDependencies,
			missingDependencies,
			contextDependencies,
			createData: {}
		};

		this.hooks.beforeResolve.callAsync(resolveData, (err, result) => {
			if (err) return callback(err, {fileDependencies, missingDependencies, contextDependencies});

			// Ignored
			if (result === false) return callback(null, {fileDependencies, missingDependencies, contextDependencies});

			if (typeof result === "object") throw new Error(deprecationChangedHookMessage("beforeResolve"));

			this.hooks.factorize.callAsync(resolveData, (err, module) => {
				if (err) return callback(err, {fileDependencies, missingDependencies, contextDependencies});

				const factoryResult = {module, fileDependencies, missingDependencies, contextDependencies};

				if (this.unsafeCache && module && this.cachePredicate(module)) {
					for (const d of dependencies) {
						dependencyCache.set(d, factoryResult);
					}
				}

				callback(null, factoryResult);
			});
		});
	}

	resolveRequestArray(contextInfo, context, array, resolver, resolveContext, callback) {
		if (array.length === 0) return callback(null, array);

		asyncLib.map(
			array,
			(item, callback) => {
				resolver.resolve(
					contextInfo,
					context,
					item.loader,
					resolveContext,
					(err, result) => {
						if (err && /^[^/]*$/.test(item.loader) && !/-loader$/.test(item.loader)) {
							return resolver.resolve(
								contextInfo,
								context,
								item.loader + "-loader",
								resolveContext,
								err2 => {
									if (!err2) err.message = err.message + "\n" + "BREAKING CHANGE: It's no longer allowed to omit the '-loader' suffix when using loaders.\n" + `                 You need to specify '${item.loader}-loader' instead of '${item.loader}',\n` + "                 see https://webpack.js.org/migrate/3/#automatic-loader-module-name-extension-removed";
									callback(err);
								}
							);
						}
						if (err) return callback(err);

						const parsedResult = identToLoaderRequest(result);
						const resolved = {
							loader: parsedResult.loader,
							options: item.options === undefined ? parsedResult.options : item.options,
							ident: item.options === undefined ? undefined : item.ident
						};

						return callback(null, resolved);
					}
				);
			},

			callback
		);
	}

	getParser(type, parserOptions = EMPTY_OBJECT) {
		let cache = this.parserCache.get(type);

		if (cache === undefined) {
			cache = new WeakMap();
			this.parserCache.set(type, cache);
		}

		let parser = cache.get(parserOptions);

		if (parser === undefined) {
			parser = this.createParser(type, parserOptions);
			cache.set(parserOptions, parser);
		}

		return parser;
	}

	createParser(type, parserOptions = {}) {
		const parser = this.hooks.createParser.for(type).call(parserOptions);
		if (!parser) throw new Error(`No parser registered for ${type}`);

		this.hooks.parser.for(type).call(parser, parserOptions);

		return parser;
	}

	getGenerator(type, generatorOptions = EMPTY_OBJECT) {
		let cache = this.generatorCache.get(type);

		if (cache === undefined) {
			cache = new WeakMap();
			this.generatorCache.set(type, cache);
		}

		let generator = cache.get(generatorOptions);

		if (generator === undefined) {
			generator = this.createGenerator(type, generatorOptions);
			cache.set(generatorOptions, generator);
		}

		return generator;
	}

	createGenerator(type, generatorOptions = {}) {
		const generator = this.hooks.createGenerator.for(type).call(generatorOptions);
		if (!generator) throw new Error(`No generator registered for ${type}`);
		this.hooks.generator.for(type).call(generator, generatorOptions);
		return generator;
	}

	getResolver(type, resolveOptions) {
		return this.resolverFactory.get(type, resolveOptions || EMPTY_OBJECT);
	}
}

module.exports = NormalModuleFactory;
