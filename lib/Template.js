/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const { ConcatSource, PrefixSource } = require("webpack-sources");
const HotUpdateChunk = require("./HotUpdateChunk");
const { compareIds } = require("./util/comparators");
const consola = require('consola')

/** @typedef {import("webpack-sources").ConcatSource} ConcatSource */
/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("./Chunk")} Chunk */
/** @typedef {import("./ChunkGraph")} ChunkGraph */
/** @typedef {import("./Compilation").AssetInfo} AssetInfo */
/** @typedef {import("./Compilation").PathData} PathData */
/** @typedef {import("./DependencyTemplates")} DependencyTemplates */
/** @typedef {import("./Module")} Module */
/** @typedef {import("./Module").CodeGenerationResult} CodeGenerationResult */
/** @typedef {import("./ModuleGraph")} ModuleGraph */
/** @typedef {import("./ModuleTemplate")} ModuleTemplate */
/** @typedef {import("./ModuleTemplate").RenderContext} RenderContext */
/** @typedef {import("./RuntimeModule")} RuntimeModule */
/** @typedef {import("./RuntimeTemplate")} RuntimeTemplate */

const START_LOWERCASE_ALPHABET_CODE = "a".charCodeAt(0);
const START_UPPERCASE_ALPHABET_CODE = "A".charCodeAt(0);
const DELTA_A_TO_Z = "z".charCodeAt(0) - START_LOWERCASE_ALPHABET_CODE + 1;
const FUNCTION_CONTENT_REGEX = /^function\s?\(\)\s?\{\r?\n?|\r?\n?\}$/g;
const INDENT_MULTILINE_REGEX = /^\t/gm;
const LINE_SEPARATOR_REGEX = /\r?\n/g;
const IDENTIFIER_NAME_REPLACE_REGEX = /^([^a-zA-Z$_])/;
const IDENTIFIER_ALPHA_NUMERIC_NAME_REPLACE_REGEX = /[^a-zA-Z0-9$]+/g;
const COMMENT_END_REGEX = /\*\//g;
const PATH_NAME_NORMALIZE_REPLACE_REGEX = /[^a-zA-Z0-9_!§$()=\-^°]+/g;
const MATCH_PADDED_HYPHENS_REPLACE_REGEX = /^-|-$/g;

/**
 * @typedef {Object} RenderManifestOptions
 * @property {Chunk} chunk the chunk used to render
 * @property {string} hash
 * @property {string} fullHash
 * @property {TODO} outputOptions
 * @property {Map<Module, CodeGenerationResult>} codeGenerationResults
 * @property {{javascript: ModuleTemplate}} moduleTemplates
 * @property {DependencyTemplates} dependencyTemplates
 * @property {RuntimeTemplate} runtimeTemplate
 * @property {ModuleGraph} moduleGraph
 * @property {ChunkGraph} chunkGraph
 */

/**
 * @typedef {Object} RenderManifestEntry
 * @property {function(): Source} render
 * @property {string | function(PathData, AssetInfo=): string} filenameTemplate
 * @property {PathData=} pathOptions
 * @property {string} identifier
 * @property {string=} hash
 * @property {boolean=} auxiliary
 */

/**
 * @typedef {Object} HasId
 * @property {number | string} id
 */

/**
 * @typedef {function(Module, number): boolean} ModuleFilterPredicate
 */

class Template {
	/**
	 *
	 * @param {Function} fn a runtime function (.runtime.js) "template"
	 * @returns {string} the updated and normalized function string
	 */
	static getFunctionContent(fn) {
		return fn
			.toString()
			.replace(FUNCTION_CONTENT_REGEX, "")
			.replace(INDENT_MULTILINE_REGEX, "")
			.replace(LINE_SEPARATOR_REGEX, "\n");
	}

	/**
	 * @param {string} str the string converted to identifier
	 * @returns {string} created identifier
	 */
	static toIdentifier(str) {
		if (typeof str !== "string") return "";
		return str
			.replace(IDENTIFIER_NAME_REPLACE_REGEX, "_$1")
			.replace(IDENTIFIER_ALPHA_NUMERIC_NAME_REPLACE_REGEX, "_");
	}
	/**
	 *
	 * @param {string} str string to be converted to commented in bundle code
	 * @returns {string} returns a commented version of string
	 */
	static toComment(str) {
		if (!str) return "";
		return `/*! ${str.replace(COMMENT_END_REGEX, "* /")} */`;
	}

	/**
	 *
	 * @param {string} str string to be converted to "normal comment"
	 * @returns {string} returns a commented version of string
	 */
	static toNormalComment(str) {
		if (!str) return "";
		return `/* ${str.replace(COMMENT_END_REGEX, "* /")} */`;
	}

	/**
	 * @param {string} str string path to be normalized
	 * @returns {string} normalized bundle-safe path
	 */
	static toPath(str) {
		if (typeof str !== "string") return "";
		return str
			.replace(PATH_NAME_NORMALIZE_REPLACE_REGEX, "-")
			.replace(MATCH_PADDED_HYPHENS_REPLACE_REGEX, "");
	}

	// map number to a single character a-z, A-Z or <_ + number> if number is too big
	/**
	 *
	 * @param {number} n number to convert to ident
	 * @returns {string} returns single character ident
	 */
	static numberToIdentifier(n) {
		// lower case
		if (n < DELTA_A_TO_Z) {
			return String.fromCharCode(START_LOWERCASE_ALPHABET_CODE + n);
		}

		// upper case
		if (n < DELTA_A_TO_Z * 2) {
			return String.fromCharCode(
				START_UPPERCASE_ALPHABET_CODE + n - DELTA_A_TO_Z
			);
		}

		// use multiple letters
		return (
			Template.numberToIdentifier(n % (2 * DELTA_A_TO_Z)) +
			Template.numberToIdentifier(Math.floor(n / (2 * DELTA_A_TO_Z)))
		);
	}

	/**
	 *
	 * @param {string | string[]} s string to convert to identity
	 * @returns {string} converted identity
	 */
	static indent(s) {
		if (Array.isArray(s)) {
			return s.map(Template.indent).join("\n");
		} else {
			const str = s.trimRight();
			if (!str) return "";
			const ind = str[0] === "\n" ? "" : "\t";
			return ind + str.replace(/\n([^\n])/g, "\n\t$1");
		}
	}

	/**
	 *
	 * @param {string|string[]} s string to create prefix for
	 * @param {string} prefix prefix to compose
	 * @returns {string} returns new prefix string
	 */
	static prefix(s, prefix) {
		const str = Template.asString(s).trim();
		if (!str) return "";
		const ind = str[0] === "\n" ? "" : prefix;
		return ind + str.replace(/\n([^\n])/g, "\n" + prefix + "$1");
	}

	/**
	 *
	 * @param {string|string[]} str string or string collection
	 * @returns {string} returns a single string from array
	 */
	static asString(str) {
		if (Array.isArray(str)) {
			return str.join("\n");
		}
		return str;
	}

	/**
	 * @typedef {Object} WithId
	 * @property {string|number} id
	 */

	/**
	 * @param {WithId[]} modules a collection of modules to get array bounds for
	 * @returns {[number, number] | false} returns the upper and lower array bounds
	 * or false if not every module has a number based id
	 */
	static getModulesArrayBounds(modules) {
		let maxId = -Infinity;
		let minId = Infinity;
		for (const module of modules) {
			const moduleId = module.id;
			if (typeof moduleId !== "number") return false;
			if (maxId < moduleId) maxId = moduleId;
			if (minId > moduleId) minId = moduleId;
		}
		if (minId < 16 + ("" + minId).length) {
			// add minId x ',' instead of 'Array(minId).concat(…)'
			minId = 0;
		}
		const objectOverhead = modules
			.map(module => (module.id + "").length + 2)
			.reduce((a, b) => a + b, -1);
		const arrayOverhead =
			minId === 0 ? maxId : 16 + ("" + minId).length + maxId;
		return arrayOverhead < objectOverhead ? [minId, maxId] : false;
	}

	/**
	 * @param {RenderContext} renderContext render context
	 * @param {Module[]} modules modules to render (should be ordered by identifier)
	 * @param {function(Module): Source} renderModule function to render a module
	 * @param {string=} prefix applying prefix strings
	 * @returns {Source} rendered chunk modules in a Source object
	 */
	static renderChunkModules(renderContext, modules, renderModule, prefix = "") {
		consola.info('➡️  执行`Template`的`renderChunkModules`方法，渲染`ChunkModules`')
		const { chunk, chunkGraph } = renderContext;

		var source = new ConcatSource();
		let removedModules;
		if (chunk instanceof HotUpdateChunk) {
			removedModules = chunk.removedModules;
		}
		if (modules.length === 0 && (!removedModules || removedModules.length === 0)) {
			return null;
		}

		/** @type {{id: string|number, source: Source|string}[]} */
		const allModules = modules.map(module => ({
			id: chunkGraph.getModuleId(module),
			source: renderModule(module) || "false"
		}));

		if (removedModules && removedModules.length > 0) {
			removedModules.sort(compareIds);
			for (const id of removedModules) {
				allModules.push({ id, source: "false" });
			}
		}

		const bounds = Template.getModulesArrayBounds(allModules);
		if (bounds) {
			// Render a spare array
			const minId = bounds[0];
			const maxId = bounds[1];
			if (minId !== 0) {
				source.add(`Array(${minId}).concat(`);
			}
			source.add("[\n");
			/** @type {Map<string|number, {id: string|number, source: Source|string}>} */
			const modules = new Map();
			for (const module of allModules) {
				modules.set(module.id, module);
			}
			for (let idx = minId; idx <= maxId; idx++) {
				const module = modules.get(idx);
				if (idx !== minId) {
					source.add(",\n");
				}
				source.add(`/* ${idx} */`);
				if (module) {
					source.add("\n");
					source.add(module.source);
				}
			}
			source.add("\n" + prefix + "]");
			if (minId !== 0) {
				source.add(")");
			}
		}
		else {
			source.add("{\n");
			for (let i = 0; i < allModules.length; i++) {
				const module = allModules[i];
				if (i !== 0) {
					source.add(",\n");
				}

				// module.id:
				// ./src/index.js
				// ./node_modules/object.is/index.js
				// ../node_modules/consola/dist/consola.browser.js
				consola.info(`🖨️  将\`${module.id}\`推入渲染结果`)

				source.add(`\n/***/ ${JSON.stringify(module.id)}:\n`);
				source.add(module.source);
			}
			source.add(`\n\n${prefix}}`);
		}

		consola.info('🆗 `ChunkModules`渲染完成～')
		return source;
	}

	/**
	 * @param {RuntimeModule[]} runtimeModules array of runtime modules in order
	 * @param {RenderContext} renderContext render context
	 * @returns {Source} rendered runtime modules in a Source object
	 */
	static renderRuntimeModules(runtimeModules, renderContext) {
		const source = new ConcatSource();
		for (const module of runtimeModules) {
			const codeGenResult = module.codeGeneration({
				chunkGraph: renderContext.chunkGraph,
				dependencyTemplates: renderContext.dependencyTemplates,
				moduleGraph: renderContext.moduleGraph,
				runtimeTemplate: renderContext.runtimeTemplate
			});
			if (codeGenResult) {
				const moduleSource = codeGenResult.sources.get("runtime");
				if (moduleSource) {
					source.add(Template.toNormalComment(module.identifier()) + "\n");
					source.add("!function() {\n");
					source.add(new PrefixSource("\t", moduleSource));
					source.add("\n}();\n\n");
				}
			}
		}
		return source;
	}

	/**
	 * @param {RuntimeModule[]} runtimeModules array of runtime modules in order
	 * @param {RenderContext} renderContext render context
	 * @returns {Source} rendered chunk runtime modules in a Source object
	 */
	static renderChunkRuntimeModules(runtimeModules, renderContext) {
		return new PrefixSource(
			"/******/ ",
			new ConcatSource(
				"function(__webpack_require__) { // webpackRuntimeModules\n",
				'\t"use strict";\n\n',
				new PrefixSource(
					"\t",
					this.renderRuntimeModules(runtimeModules, renderContext)
				),
				"}\n"
			)
		);
	}
}

module.exports = Template;
