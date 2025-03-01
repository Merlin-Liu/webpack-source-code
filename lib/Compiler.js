/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const consola = require('consola')
const parseJson = require("json-parse-better-errors");
const asyncLib = require("neo-async");
const {
	SyncHook,
	SyncBailHook,
	AsyncParallelHook,
	AsyncSeriesHook
} = require("tapable");
const { SizeOnlySource } = require("webpack-sources");

const Cache = require("./Cache");
const Compilation = require("./Compilation");
const ConcurrentCompilationError = require("./ConcurrentCompilationError");
const ContextModuleFactory = require("./ContextModuleFactory");
const NormalModuleFactory = require("./NormalModuleFactory");
const RequestShortener = require("./RequestShortener");
const ResolverFactory = require("./ResolverFactory");
const Stats = require("./Stats");
const Watching = require("./Watching");
const { Logger } = require("./logging/Logger");
const { join, dirname, mkdirp } = require("./util/fs");
const { makePathsRelative } = require("./util/identifier");

/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("../declarations/WebpackOptions").Entry} Entry */
/** @typedef {import("../declarations/WebpackOptions").OutputOptions} OutputOptions */
/** @typedef {import("../declarations/WebpackOptions").WatchOptions} WatchOptions */
/** @typedef {import("../declarations/WebpackOptions").WebpackOptions} WebpackOptions */
/** @typedef {import("../declarations/WebpackOptions").WebpackPluginInstance} WebpackPluginInstance */
/** @typedef {import("./Chunk")} Chunk */
/** @typedef {import("./FileSystemInfo").FileSystemInfoEntry} FileSystemInfoEntry */
/** @typedef {import("./Module")} Module */
/** @typedef {import("./util/fs").InputFileSystem} InputFileSystem */
/** @typedef {import("./util/fs").IntermediateFileSystem} IntermediateFileSystem */
/** @typedef {import("./util/fs").OutputFileSystem} OutputFileSystem */

/**
 * @typedef {Object} CompilationParams
 * @property {NormalModuleFactory} normalModuleFactory
 * @property {ContextModuleFactory} contextModuleFactory
 */

/**
 * @template T
 * @callback Callback
 * @param {Error=} err
 * @param {T=} result
 */

/**
 * @callback RunAsChildCallback
 * @param {Error=} err
 * @param {Chunk[]=} entries
 * @param {Compilation=} compilation
 */

/**
 * @typedef {Object} AssetEmittedInfo
 * @property {Buffer} content
 * @property {Source} source
 * @property {Compilation} compilation
 * @property {string} outputPath
 * @property {string} targetPath
 */

/**
 * @param {string[]} array an array
 * @returns {boolean} true, if the array is sorted
 */
const isSorted = array => {
	for (let i = 1; i < array.length; i++) {
		if (array[i - 1] > array[i]) return false;
	}
	return true;
};

/**
 * @param {Object} obj an object
 * @param {string[]} keys the keys of the object
 * @returns {Object} the object with properties sorted by property name
 */
const sortObject = (obj, keys) => {
	return keys.sort().reduce((o, k) => {
		o[k] = obj[k];
		return o;
	}, {});
};

class Compiler {
	/**
	 * @param {string} context the compilation path
	 * path，基础目录，绝对路径，用于从配置中解析入口起点(entry point)和loader
	 */
	constructor(context) {
		// 所有钩子都是由`Tapable`提供的，不同钩子类型在触发时，调用时序也不同
		this.hooks = Object.freeze({
			/** @type {SyncBailHook<[Compilation], boolean>} */
			shouldEmit: new SyncBailHook(["compilation"]),

			/** @type {AsyncSeriesHook<[Stats]>} */
			done: new AsyncSeriesHook(["stats"]),

			/** @type {SyncHook<[Stats]>} */
			afterDone: new SyncHook(["stats"]),

			/** @type {AsyncSeriesHook<[]>} */
			additionalPass: new AsyncSeriesHook([]),

			/** @type {AsyncSeriesHook<[Compiler]>} */
			beforeRun: new AsyncSeriesHook(["compiler"]),

			/** @type {AsyncSeriesHook<[Compiler]>} */
			run: new AsyncSeriesHook(["compiler"]),

			/** @type {AsyncSeriesHook<[Compilation]>} */
			emit: new AsyncSeriesHook(["compilation"]),

			/** @type {AsyncSeriesHook<[string, AssetEmittedInfo]>} */
			assetEmitted: new AsyncSeriesHook(["file", "info"]),

			/** @type {AsyncSeriesHook<[Compilation]>} */
			afterEmit: new AsyncSeriesHook(["compilation"]),

			/** @type {SyncHook<[Compilation, CompilationParams]>} */
			thisCompilation: new SyncHook(["compilation", "params"]),

			/** @type {SyncHook<[Compilation, CompilationParams]>} */
			compilation: new SyncHook(["compilation", "params"]),

			/** @type {SyncHook<[NormalModuleFactory]>} */
			normalModuleFactory: new SyncHook(["normalModuleFactory"]),

			/** @type {SyncHook<[ContextModuleFactory]>}  */
			contextModuleFactory: new SyncHook(["contextModulefactory"]),

			/** @type {AsyncSeriesHook<[CompilationParams]>} */
			beforeCompile: new AsyncSeriesHook(["params"]),

			/** @type {SyncHook<[CompilationParams]>} */
			compile: new SyncHook(["params"]),

			/** @type {AsyncParallelHook<[Compilation], Module>} */
			make: new AsyncParallelHook(["compilation"]),

			/** @type {AsyncSeriesHook<[Compilation]>} */
			afterCompile: new AsyncSeriesHook(["compilation"]),

			/** @type {AsyncSeriesHook<[Compiler]>} */
			watchRun: new AsyncSeriesHook(["compiler"]),

			/** @type {SyncHook<[Error]>} */
			failed: new SyncHook(["error"]),

			/** @type {SyncHook<[string, string]>} */
			invalid: new SyncHook(["filename", "changeTime"]),

			/** @type {SyncHook<[]>} */
			watchClose: new SyncHook([]),

			/** @type {SyncBailHook<[string, string, any[]], true>} */
			infrastructureLog: new SyncBailHook(["origin", "type", "args"]),

			// TODO the following hooks are weirdly located here
			// TODO move them for webpack 5
			/** @type {SyncHook<[]>} */
			environment: new SyncHook([]),

			/** @type {SyncHook<[]>} */
			afterEnvironment: new SyncHook([]),

			/** @type {SyncHook<[Compiler]>} */
			afterPlugins: new SyncHook(["compiler"]),

			/** @type {SyncHook<[Compiler]>} */
			afterResolvers: new SyncHook(["compiler"]),

			/** @type {SyncBailHook<[string, Entry], boolean>} */
			entryOption: new SyncBailHook(["context", "entry"])
		});

		/** @type {string=} */
		this.name = undefined;
		/** @type {Compilation=} */
		this.parentCompilation = undefined;
		/** @type {Compiler} */
		this.root = this;
		/** @type {string} */
		this.outputPath = "";

		/** @type {OutputFileSystem} */
		this.outputFileSystem = null;
		/** @type {IntermediateFileSystem} */
		this.intermediateFileSystem = null;
		/** @type {InputFileSystem} */
		this.inputFileSystem = null;
		this.watchFileSystem = null;

		/** @type {string|null} */
		this.recordsInputPath = null;
		/** @type {string|null} */
		this.recordsOutputPath = null;
		this.records = {};
		/** @type {Set<string>} */
		this.managedPaths = new Set();
		/** @type {Set<string>} */
		this.immutablePaths = new Set();

		/** @type {Set<string>} */
		this.modifiedFiles = undefined;
		/** @type {Set<string>} */
		this.removedFiles = undefined;
		/** @type {Map<string, FileSystemInfoEntry | null>} */
		this.fileTimestamps = undefined;
		/** @type {Map<string, FileSystemInfoEntry | null>} */
		this.contextTimestamps = undefined;

		/** @type {ResolverFactory} */
		this.resolverFactory = new ResolverFactory();

		this.infrastructureLogger = undefined;

		/** @type {WebpackOptions} */
		this.options = /** @type {WebpackOptions} */ ({});

		this.context = context;

		this.requestShortener = new RequestShortener(context);

		this.cache = new Cache();

		this.compilerPath = "";

		/** @type {boolean} */
		this.running = false;

		/** @type {boolean} */
		this.watchMode = false;

		/** @private @type {WeakMap<Source, { sizeOnlySource: SizeOnlySource, writtenTo: Map<string, number> }>} */
		this._assetEmittingSourceCache = new WeakMap();
		/** @private @type {Map<string, number>} */
		this._assetEmittingWrittenFiles = new Map();
	}

	/**
	 * @param {string | (function(): string)} name name of the logger, or function called once to get the logger name
	 * @returns {Logger} a logger with that name
	 */
	getInfrastructureLogger(name) {
		if (!name) {
			throw new TypeError(
				"Compiler.getInfrastructureLogger(name) called without a name"
			);
		}
		return new Logger(
			(type, args) => {
				if (typeof name === "function") {
					name = name();
					if (!name) {
						throw new TypeError(
							"Compiler.getInfrastructureLogger(name) called with a function not returning a name"
						);
					}
				}
				if (this.hooks.infrastructureLog.call(name, type, args) === undefined) {
					if (this.infrastructureLogger !== undefined) {
						this.infrastructureLogger(name, type, args);
					}
				}
			},
			childName => {
				if (typeof name === "function") {
					if (typeof childName === "function") {
						return this.getInfrastructureLogger(() => {
							if (typeof name === "function") {
								name = name();
								if (!name) {
									throw new TypeError(
										"Compiler.getInfrastructureLogger(name) called with a function not returning a name"
									);
								}
							}
							if (typeof childName === "function") {
								childName = childName();
								if (!childName) {
									throw new TypeError(
										"Logger.getChildLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					} else {
						return this.getInfrastructureLogger(() => {
							if (typeof name === "function") {
								name = name();
								if (!name) {
									throw new TypeError(
										"Compiler.getInfrastructureLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					}
				} else {
					if (typeof childName === "function") {
						return this.getInfrastructureLogger(() => {
							if (typeof childName === "function") {
								childName = childName();
								if (!childName) {
									throw new TypeError(
										"Logger.getChildLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					} else {
						return this.getInfrastructureLogger(`${name}/${childName}`);
					}
				}
			}
		);
	}

	/**
	 * @param {WatchOptions} watchOptions the watcher's options
	 * @param {Callback<Stats>} handler signals when the call finishes
	 * @returns {Watching} a compiler watcher
	 */
	watch(watchOptions, handler) {
		if (this.running) {
			return handler(new ConcurrentCompilationError());
		}

		this.running = true;
		this.watchMode = true;
		return new Watching(this, watchOptions, handler);
	}

	/**
	 * @param {Callback<Stats>} callback signals when the call finishes
	 * @returns {void}
	 * 监听了钩住了编译过程的一些阶段，并在相应阶段去调用已经提前注册好的钩子函数(this.hooks.xxxx.call(this))
	 * 效果与React、Vue中生命周期函数是一样的
	 * 在run函数中出现的钩子有：beforeRun --> run --> done --> afterDone
	 */
	run(callback) {
		consola.info('5⃣️  执行`Complier`的`run`方法')

		if (this.running) {
			return callback(new ConcurrentCompilationError());
		}

		let logger;

		const finalCallback = (err, stats) => {
			if (logger) logger.time("beginIdle");
			this.cache.beginIdle();
			if (logger) logger.timeEnd("beginIdle");
			this.running = false;
			if (err) {
				this.hooks.failed.call(err);
			}
			if (callback !== undefined) callback(err, stats);
			this.hooks.afterDone.call(stats);
		};

		const startTime = Date.now();

		this.running = true;

		const onCompiled = (err, compilation) => {
			if (err) return finalCallback(err);

			if (this.hooks.shouldEmit.call(compilation) === false) {
				const stats = new Stats(compilation);
				stats.startTime = startTime;
				stats.endTime = Date.now();
				this.hooks.done.callAsync(stats, err => {
					if (err) return finalCallback(err);
					return finalCallback(null, stats);
				});
				return;
			}

			process.nextTick(() => {
				logger = compilation.getLogger("webpack.Compiler");
				logger.time("emitAssets");

				this.emitAssets(compilation, err => {
					logger.timeEnd("emitAssets");

					consola.info('3⃣️ 6⃣️  `Compiler`的`emitAssets`执行完成，静态资源生成完成 ✅ ')

					if (err) return finalCallback(err);

					if (compilation.hooks.needAdditionalPass.call()) {
						compilation.needAdditionalPass = true;

						const stats = new Stats(compilation);
						stats.startTime = startTime;
						stats.endTime = Date.now();
						logger.time("done hook");
						this.hooks.done.callAsync(stats, err => {
							logger.timeEnd("done hook");
							if (err) return finalCallback(err);

							this.hooks.additionalPass.callAsync(err => {
								if (err) return finalCallback(err);
								this.compile(onCompiled);
							});
						});
						return;
					}

					logger.time("emitRecords");
					this.emitRecords(err => {
						logger.timeEnd("emitRecords");
						if (err) return finalCallback(err);

						const stats = new Stats(compilation);
						stats.startTime = startTime;
						stats.endTime = Date.now();
						logger.time("done hook");

						this.hooks.done.callAsync(stats, err => {
							logger.timeEnd("done hook");
							if (err) return finalCallback(err);

							consola.success('3⃣️ 7⃣️  `Compiler`编译器`run`方法执行完成 💯 ')

							return finalCallback(null, stats);
						});
					});
				});
			});
		};

		this.cache.endIdle(err => {
			if (err) return finalCallback(err);

			this.hooks.beforeRun.callAsync(this, err => {
				if (err) return finalCallback(err);

				this.hooks.run.callAsync(this, err => {
					if (err) return finalCallback(err);

					this.readRecords(err => {
						if (err) return finalCallback(err);

						this.compile(onCompiled);
					});
				});
			});
		});
	}

	/**
	 * @param {RunAsChildCallback} callback signals when the call finishes
	 * @returns {void}
	 */
	runAsChild(callback) {
		this.compile((err, compilation) => {
			if (err) return callback(err);

			this.parentCompilation.children.push(compilation);
			for (const { name, source, info } of compilation.getAssets()) {
				this.parentCompilation.emitAsset(name, source, info);
			}

			const entries = Array.from(
				compilation.entrypoints.values(),
				ep => ep.chunks
			).reduce((array, chunks) => {
				return array.concat(chunks);
			}, []);

			return callback(null, entries, compilation);
		});
	}

	purgeInputFileSystem() {
		if (this.inputFileSystem && this.inputFileSystem.purge) {
			this.inputFileSystem.purge();
		}
	}

	/**
	 * @param {Compilation} compilation the compilation
	 * @param {Callback<void>} callback signals when the assets are emitted
	 * @returns {void}
	 */
	emitAssets(compilation, callback) {
		let outputPath;

		consola.info('3⃣️ 1⃣️  进入`Compiler`的`emitAssets`开生成静态资源')

		const emitFiles = err => {
			if (err) return callback(err);

			asyncLib.forEachLimit(compilation.getAssets(), 15,
				({ name: file, source, info }, callback) => {
					let targetFile = file;

					const queryStringIdx = targetFile.indexOf("?");
					if (queryStringIdx >= 0) {
						targetFile = targetFile.substr(0, queryStringIdx);
					}

					const writeOut = err => {
						if (err) return callback(err);

						const targetPath = join(this.outputFileSystem, outputPath, targetFile);

						// check if the target file has already been written by this Compiler
						const targetFileGeneration = this._assetEmittingWrittenFiles.get(targetPath);

						// create an cache entry for this Source if not already existing
						let cacheEntry = this._assetEmittingSourceCache.get(source);
						if (cacheEntry === undefined) {
							cacheEntry = {
								sizeOnlySource: undefined,
								writtenTo: new Map()
							};
							this._assetEmittingSourceCache.set(source, cacheEntry);
						}

						/**
						 * get the binary (Buffer) content from the Source
						 * @returns {Buffer} content for the source
						 */
						const getContent = () => {
							consola.info('3⃣️ 4⃣️  得到最终的文件内容，type `String`/`Buffer`')

							if (typeof source.buffer === "function") {
								return source.buffer();
							}
							else {
								const bufferOrString = source.source();
								if (Buffer.isBuffer(bufferOrString)) {
									return bufferOrString;
								}
								else {
									return Buffer.from(bufferOrString, "utf8");
								}
							}
						};

						const alreadyWritten = () => {
							// const stack = (ErrCtor => {
							// 	const obj = Object.create(null)
							// 	ErrCtor.captureStackTrace(obj);
							// 	return obj.stack
							// })(Error)

							// cache the information that the Source has been already been written to that location
							if (targetFileGeneration === undefined) {
								const newGeneration = 1;
								this._assetEmittingWrittenFiles.set(targetPath, newGeneration);
								cacheEntry.writtenTo.set(targetPath, newGeneration);
							}
							else {
								cacheEntry.writtenTo.set(targetPath, targetFileGeneration);
							}
							callback();
						};

						/**
						 * Write the file to output file system
						 * @param {Buffer} content @type Buffer content to be written
						 * @returns {void}
						 */
						const doWrite = content  => {
							consola.info(`3⃣️ 5⃣️  开始执行写文件操作，生成的文件名：\`${file}\``);

							this.outputFileSystem.writeFile(targetPath, content, err => {
								if (err) return callback(err);

								consola.success(`✏️  写文件完成`);

								// information marker that the asset has been emitted
								compilation.emittedAssets.add(file);

								// cache the information that the Source has been written to that location
								const newGeneration = targetFileGeneration === undefined ? 1 : targetFileGeneration + 1;
								cacheEntry.writtenTo.set(targetPath, newGeneration);
								this._assetEmittingWrittenFiles.set(targetPath, newGeneration);
								this.hooks.assetEmitted.callAsync(
									file,
									{
										content,
										source,
										outputPath,
										compilation,
										targetPath
									},
									callback
								);
							});
						};

						const updateWithReplacementSource = size => {
							// Create a replacement resource which only allows to ask for size
							// This allows to GC all memory allocated by the Source
							// (expect when the Source is stored in any other cache)
							if (!cacheEntry.sizeOnlySource) {
								cacheEntry.sizeOnlySource = new SizeOnlySource(size);
							}
							compilation.updateAsset(file, cacheEntry.sizeOnlySource, {
								size
							});
						};

						const processExistingFile = stats => {
							// skip emitting if it's already there and an immutable file
							if (info.immutable) {
								updateWithReplacementSource(stats.size);
								return alreadyWritten();
							}

							const content = getContent();

							updateWithReplacementSource(content.length);

							// if it exists and content on disk matches content
							// skip writing the same content again
							// (to keep mtime and don't trigger watchers)
							// for a fast negative match file size is compared first
							if (content.length === stats.size) {
								compilation.comparedForEmitAssets.add(file);
								return this.outputFileSystem.readFile(targetPath, (err, existingContent) => {
									// 内容不相等，覆盖
									if (err || !content.equals(existingContent)) {
										return doWrite(content);
									}
									// 如果进入到这里，证明打包后的结果未曾发生过变化
									else {
										consola.info(`3⃣️ 5⃣️  打包后的文件\`${targetFile}\`内容未发生变化~`)
										return alreadyWritten();
									}
								});
							}

							return doWrite(content);
						};

						const processMissingFile = () => {
							const content = getContent();

							updateWithReplacementSource(content.length);

							return doWrite(content);
						};

						// if the target file has already been written
						if (targetFileGeneration !== undefined) {
							// check if the Source has been written to this target file
							const writtenGeneration = cacheEntry.writtenTo.get(targetPath);
							if (writtenGeneration === targetFileGeneration) {
								// if yes, we skip writing the file
								// as it's already there
								// (we assume one doesn't remove files while the Compiler is running)

								compilation.updateAsset(file, cacheEntry.sizeOnlySource, {
									size: cacheEntry.sizeOnlySource.size()
								});

								return callback();
							}

							if (!info.immutable) {
								// We wrote to this file before which has very likly a different content
								// skip comparing and assume content is different for performance
								// This case happens often during watch mode.
								return processMissingFile();
							}
						}

						if (this.options.output.compareBeforeEmit) { // true
							this.outputFileSystem.stat(targetPath, (err, stats) => {
								const exists = !err && stats.isFile();

								if (exists) {
									// 文件存在
									consola.info(`3⃣️ 3⃣️  生成的目标文件\`${targetFile}\`已经存在`)
									processExistingFile(stats);
								}
								else {
									// 文件不存在
									processMissingFile();
								}
							});
						}
						else {
							processMissingFile();
						}
					};

					// 带路径的entry
					if (targetFile.match(/\/|\\/)) {
						const fs = this.outputFileSystem;
						const dir = dirname(fs, join(fs, outputPath, targetFile));
						mkdirp(fs, dir, writeOut);
					}
					else {
						writeOut();
					}
				},

				err => {
					if (err) return callback(err);

					this.hooks.afterEmit.callAsync(compilation, err => {
						if (err) return callback(err);

						return callback();
					});
				}
			);
		};

		this.hooks.emit.callAsync(compilation, err => {
			if (err) return callback(err);
			outputPath = compilation.getPath(this.outputPath, {});
			consola.info(`3⃣️ 2⃣️  创建生成静态资源的目录，路径为\`${outputPath}\``)
			mkdirp(this.outputFileSystem, outputPath, emitFiles);
		});
	}

	/**
	 * @param {Callback<void>} callback signals when the call finishes
	 * @returns {void}
	 */
	emitRecords(callback) {
		if (!this.recordsOutputPath) return callback();

		const writeFile = () => {
			this.outputFileSystem.writeFile(
				this.recordsOutputPath,
				JSON.stringify(
					this.records,
					(n, value) => {
						if (
							typeof value === "object" &&
							value !== null &&
							!Array.isArray(value)
						) {
							const keys = Object.keys(value);
							if (!isSorted(keys)) {
								return sortObject(value, keys);
							}
						}
						return value;
					},
					2
				),
				callback
			);
		};

		const recordsOutputPathDirectory = dirname(this.outputFileSystem, this.recordsOutputPath);
		if (!recordsOutputPathDirectory) {
			return writeFile();
		}

		mkdirp(this.outputFileSystem, recordsOutputPathDirectory, err => {
			if (err) return callback(err);
			writeFile();
		});
	}

	/**
	 * @param {Callback<void>} callback signals when the call finishes
	 * @returns {void}
	 */
	readRecords(callback) {
		if (!this.recordsInputPath) {
			this.records = {};

			return callback();
		}

		this.inputFileSystem.stat(this.recordsInputPath, err => {
			// It doesn't exist We can ignore this. 不存在，忽略
			if (err) return callback();

			this.inputFileSystem.readFile(this.recordsInputPath, (err, content) => {
				if (err) return callback(err);

				try {
					this.records = parseJson(content.toString("utf-8"));
				}
				catch (e) {
					e.message = "Cannot parse records: " + e.message;
					return callback(e);
				}

				return callback();
			});
		});
	}

	/**
	 * @param {Compilation} compilation the compilation
	 * @param {string} compilerName the compiler's name
	 * @param {number} compilerIndex the compiler's index
	 * @param {OutputOptions} outputOptions the output options
	 * @param {WebpackPluginInstance[]} plugins the plugins to apply
	 * @returns {Compiler} a child compiler
	 */
	createChildCompiler(compilation, compilerName, compilerIndex, outputOptions, plugins) {
		const childCompiler = new Compiler(this.context);
		if (Array.isArray(plugins)) {
			for (const plugin of plugins) {
				plugin.apply(childCompiler);
			}
		}
		for (const name in this.hooks) {
			if (!["make", "compile", "emit", "afterEmit", "invalid", "done", "thisCompilation"].includes(name)) {
				if (childCompiler.hooks[name]) {
					childCompiler.hooks[name].taps = this.hooks[name].taps.slice();
				}
			}
		}
		childCompiler.name = compilerName;
		childCompiler.outputPath = this.outputPath;
		childCompiler.inputFileSystem = this.inputFileSystem;
		childCompiler.outputFileSystem = null;
		childCompiler.resolverFactory = this.resolverFactory;
		childCompiler.modifiedFiles = this.modifiedFiles;
		childCompiler.removedFiles = this.removedFiles;
		childCompiler.fileTimestamps = this.fileTimestamps;
		childCompiler.contextTimestamps = this.contextTimestamps;
		childCompiler.compilerPath =
			this.compilerPath + "/" + compilerName + compilerIndex;

		const relativeCompilerName = makePathsRelative(
			this.context,
			compilerName,
			this.root
		);
		if (!this.records[relativeCompilerName]) {
			this.records[relativeCompilerName] = [];
		}
		if (this.records[relativeCompilerName][compilerIndex]) {
			childCompiler.records = this.records[relativeCompilerName][compilerIndex];
		} else {
			this.records[relativeCompilerName].push((childCompiler.records = {}));
		}

		childCompiler.options = {
			...this.options,
			output: {
				...this.options.output,
				...outputOptions
			}
		};
		childCompiler.parentCompilation = compilation;
		childCompiler.root = this.root;

		compilation.hooks.childCompiler.call(
			childCompiler,
			compilerName,
			compilerIndex
		);

		return childCompiler;
	}

	isChild() {
		return !!this.parentCompilation;
	}

	createCompilation() {
		return new Compilation(this);
	}

	/**
	 * @param {CompilationParams} params the compilation parameters
	 * @returns {Compilation} the created compilation
	 */
	newCompilation(params) {
		const compilation = this.createCompilation();
		compilation.name = this.name;
		compilation.records = this.records;
		this.hooks.thisCompilation.call(compilation, params);
		this.hooks.compilation.call(compilation, params);
		return compilation;
	}

	createNormalModuleFactory() {
		const normalModuleFactory = new NormalModuleFactory({
			context: this.options.context,
			fs: this.inputFileSystem,
			resolverFactory: this.resolverFactory,
			options: this.options.module || {}
		});
		this.hooks.normalModuleFactory.call(normalModuleFactory);
		return normalModuleFactory;
	}

	createContextModuleFactory() {
		const contextModuleFactory = new ContextModuleFactory(this.resolverFactory);
		this.hooks.contextModuleFactory.call(contextModuleFactory);
		return contextModuleFactory;
	}

	newCompilationParams() {
		const params = {
			normalModuleFactory: this.createNormalModuleFactory(),
			contextModuleFactory: this.createContextModuleFactory()
		};
		return params;
	}

	/**
	 * @param {Callback<Compilation>} callback signals when the compilation finishes
	 * @returns {void}
	 * 同run函数一样，触发了一系列的钩子函数
	 * 在compile函数中出现的钩子有：beforeCompile --> compile --> make --> afterCompile
	 */
	compile(callback) {
		consola.info('6⃣️  执行`Complier`的`compile`方法')

		const params = this.newCompilationParams(); // 初始化模块工厂对象

		this.hooks.beforeCompile.callAsync(params, err => {
			if (err) return callback(err);

			this.hooks.compile.call(params);

			// 创建Compilation实例
			// compilation记录本次编译作业的环境信息
			consola.info('7⃣️  创建`Compilation`实例')
			const compilation = this.newCompilation(params);

			const logger = compilation.getLogger("webpack.Compiler");

			logger.time("make hook");

			consola.info('8⃣️  触发「`make`」钩子')
			this.hooks.make.callAsync(compilation, err => {
				consola.success('🍺 监听「`make`」钩子的「`EntryPlugin`」插件执行完成')

				logger.timeEnd("make hook");
				if (err) return callback(err);

				process.nextTick(() => {
					logger.time("finish compilation");

					compilation.finish(err => {
						logger.timeEnd("finish compilation");
						if (err) return callback(err);

						logger.time("seal compilation");

						// seal =》 封装
						consola.info(`2⃣️ 3⃣️  依赖收集完成，开始执行\`Compilation\`的\`seal\`方法`)
						compilation.seal(err => {
							consola.info(`3⃣️ 0⃣️  \`Compilation\`的\`seal\`执行完成`)
							logger.timeEnd("seal compilation");
							if (err) return callback(err);

							logger.time("afterCompile hook");
							this.hooks.afterCompile.callAsync(compilation, err => {
								logger.timeEnd("afterCompile hook");
								if (err) return callback(err);

								return callback(null, compilation);
							});
						});
					});
				});
			});
		});
	}

	/**
	 * @param {Callback<void>} callback signals when the compiler closes
	 * @returns {void}
	 */
	close(callback) {
		this.cache.shutdown(callback);
	}
}

module.exports = Compiler;
