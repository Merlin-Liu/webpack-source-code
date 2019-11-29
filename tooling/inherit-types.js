const path = require("path");
const fs = require("fs");
const ts = require("typescript");
const program = require("./typescript-program");

// When --override is set, base jsdoc will override sub class jsdoc
// Elsewise on a conflict it will create a merge conflict in the file
const override = process.argv.includes("--override");

// When --write is set, files will be written in place
// Elsewise it only prints outdated files
const doWrite = process.argv.includes("--write");

const typeChecker = program.getTypeChecker();

/**
 * @param {ts.ClassDeclaration | ts.ClassExpression} node the class declaration
 * @returns {Set<ts.ClassDeclaration | ts.ClassExpression>} the base class declarations
 */
const getBaseClasses = node => {
	try {
		/** @type {Set<ts.ClassDeclaration | ts.ClassExpression>} */
		const decls = new Set();
		if (node.heritageClauses) {
			for (const clause of node.heritageClauses) {
				for (const clauseType of clause.types) {
					const type = typeChecker.getTypeAtLocation(clauseType);
					if (type.symbol) {
						const decl = type.symbol.valueDeclaration;
						if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl))
							decls.add(decl);
					}
				}
			}
		}
		return decls;
	} catch (e) {
		e.message += ` while getting the base class of ${node.name}`;
		throw e;
	}
};

/**
 * @param {ts.ClassDeclaration | ts.ClassExpression} classNode the class declaration
 * @param {string} memberName name of the member
 * @returns {ts.MethodDeclaration | null} base class member declaration when found
 */
const findDeclarationInBaseClass = (classNode, memberName) => {
	for (const baseClass of getBaseClasses(classNode)) {
		for (const node of baseClass.members) {
			if (ts.isMethodDeclaration(node)) {
				if (node.name.getText() === memberName) {
					return node;
				}
			}
		}
		const result = findDeclarationInBaseClass(baseClass, memberName);
		if (result) return result;
	}
	return null;
};

const libPath = path.resolve(__dirname, "../lib");

for (const sourceFile of program.getSourceFiles()) {
	let file = sourceFile.fileName;
	if (
		file.toLowerCase().startsWith(libPath.replace(/\\/g, "/").toLowerCase())
	) {
		const updates = [];

		/**
		 * @param {ts.Node} node the traversed node
		 * @returns {void}
		 */
		const nodeHandler = node => {
			if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
				for (const member of node.members) {
					if (ts.isMethodDeclaration(member)) {
						const baseDecl = findDeclarationInBaseClass(
							node,
							member.name.getText()
						);
						if (baseDecl) {
							const memberAsAny = /** @type {TODO} */ (member);
							const baseDeclAsAny = /** @type {TODO} */ (baseDecl);
							const currentJsDoc = memberAsAny.jsDoc && memberAsAny.jsDoc[0];
							const baseJsDoc = baseDeclAsAny.jsDoc && baseDeclAsAny.jsDoc[0];
							const currentJsDocText =
								currentJsDoc && currentJsDoc.getText().replace(/\r\n?/g, "\n");
							let baseJsDocText =
								baseJsDoc && baseJsDoc.getText().replace(/\r\n?/g, "\n");
							if (baseJsDocText) {
								baseJsDocText = baseJsDocText.replace(
									/\t \* @abstract\r?\n/g,
									""
								);
								if (!currentJsDocText) {
									// add js doc
									updates.push({
										member: member.name.getText(),
										start: member.getStart(),
										end: member.getStart(),
										content: baseJsDocText + "\n\t",
										oldContent: ""
									});
								} else if (
									baseJsDocText &&
									currentJsDocText !== baseJsDocText
								) {
									// update js doc
									if (override || !doWrite) {
										updates.push({
											member: member.name.getText(),
											start: currentJsDoc.getStart(),
											end: currentJsDoc.getEnd(),
											content: baseJsDocText,
											oldContent: currentJsDocText
										});
									} else {
										updates.push({
											member: member.name.getText(),
											start: currentJsDoc.getStart() - 1,
											end: currentJsDoc.getEnd(),
											content: `<<<<<<< original comment\n\t${currentJsDocText}\n=======\n\t${baseJsDocText}\n>>>>>>> comment from base class`
										});
									}
								}
							}
						}
					}
				}
			} else {
				node.forEachChild(nodeHandler);
			}
		};
		try {
			sourceFile.forEachChild(nodeHandler);
		} catch (e) {
			e.message += ` while processing ${file}`;
			throw e;
		}

		if (updates.length > 0) {
			if (doWrite) {
				let fileContent = fs.readFileSync(file, "utf-8");
				updates.sort((a, b) => {
					return b.start - a.start;
				});
				for (const update of updates) {
					fileContent =
						fileContent.substr(0, update.start) +
						update.content +
						fileContent.substr(update.end);
				}
				console.log(`${file} ${updates.length} JSDoc comments added/updated`);
				fs.writeFileSync(file, fileContent, "utf-8");
			} else {
				console.log(file);
				for (const update of updates) {
					console.log(
						`* ${update.member} should have this JSDoc:\n\t${update.content}`
					);
					if (update.oldContent) {
						console.log(`instead of\n\t${update.oldContent}`);
					}
				}
				console.log();
				process.exitCode = 1;
			}
		}
	}
}
