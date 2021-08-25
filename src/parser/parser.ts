import { Visitor } from "@src/utils/visitor";
import Glob from "glob";
import ts from "typescript";
import { AllNodes, AssertOptions, BasicScalar, Enum, EnumMember, InputField, List, MethodDescriptor, ModelKind, Node, ObjectLiteral, OutputField, Param, PlainObject, Reference, Scalar, Union } from "./model";
import { DEFAULT_SCALARS } from "./types";
import JSON5 from 'json5';
import { info, warn } from "@src/utils/log";
const {parse: parseJSON}= JSON5;

/** Parse files */
export function parse(pathPatterns:string[], compilerOptions: ts.CompilerOptions): Map<string, Node>{
	const ROOT: Map<string, Node>= new Map();
	//* Load files using glob
	const files:string[]= [];
	for(let i=0, len= pathPatterns.length; i<len; ++i){
		let f= Glob.sync(pathPatterns[i]);
		for(let j=0, jLen= f.length; j<jLen; ++j){
			let file= f[j];
			if(files.includes(file)===false){
				files.push(file);
				console.log('\t>', file);
			}
		}
	}
	if (files.length === 0)
		throw new Error(`Model Parser>> No file found for pattern: ${pathPatterns.join(', ')}`);
	//* Create compiler host
	info('>> Create program...');
	const pHost= ts.createCompilerHost(compilerOptions, true); 
	//* Create program
	const program= ts.createProgram(files, compilerOptions, pHost);
	const typeChecker= program.getTypeChecker();
	//* STEP 1: RESOLVE EVERYTHING WITHOUT INHIRETANCE
	info('>> Parsing...');
	const visitor= new Visitor<ts.Node, AllNodes>();
	// var srcFiles= program.getSourceFiles();
	for(let i=0, len=files.length; i<len; ++i){
		let srcFile= program.getSourceFile(files[i])!;
		// if(srcFile.isDeclarationFile) continue;
		visitor.push(srcFile.getChildren(), undefined, srcFile);
	}
	const it= visitor.it();
	var nodeName: string|undefined;
	const namelessEntities: NamelessEntity[]= [];
	const warns: string[]= [];
	/** Used to generate entity id */
	var idIt= 0;
	rootLoop: while(true){
		// get next item
		let item= it.next();
		if(item.done) break;
		let {node, parentDescriptor: pDesc, srcFile, isInput}= item.value;
		let nodeType= typeChecker.getTypeAtLocation(node);
		let nodeSymbol= nodeType.symbol;
		// Flags
		let deprecated: string|undefined= undefined
		let asserts: string[]= [];
		// Extract JSDoc
		// let jsDoc= nodeSymbol?.getDocumentationComment(typeChecker).map(e=> e.text) ?? [];
		let jsDoc=
			nodeSymbol?.getDocumentationComment(typeChecker).map(e=> e.text)
			?? [(node.getChildren().find(e=>e.kind===ts.SyntaxKind.JSDocComment) as ts.JSDoc)?.comment]
			?? [];
		let jsDocTags= ts.getJSDocTags(node);
		let defaultValue: string|undefined;
		let fieldAlias: string|undefined;
		if(jsDocTags.length){
			for(let i=0, len= jsDocTags.length; i<len; ++i){
				let tag= jsDocTags[i];
				jsDoc.push(tag.getText());
				let tagName= tag.tagName.getText();
				let tagText:any;
				switch(tagName){
					case 'ignore':
						// Ignore this Node
						continue rootLoop;
					case 'deprecated':
						tagText= tag.comment;
						if(Array.isArray(tagText))
							tagText= tagText.map((l: ts.JSDocText)=> l.text).join("\n");
						deprecated= tagText.toString();
						break;
					case 'assert':
						tagText= tag.comment;
						if(Array.isArray(tagText))
							tagText= tagText.map((l: ts.JSDocText)=> l.text).join(', ');
						// FIXME check using multiple lines for jsdoc tag
						if(tagText){
							tagText= tagText.trim();
							if(!tagText.startsWith('{')) tagText= `{${tagText}}`;
							asserts.push(tagText);
						}
						break;
					case 'default':
						defaultValue= (tag.comment?.[0] as ts.JSDocText).text;
						break;
					case 'input':
						isInput= true;
						break;
					case 'output':
						isInput= false;
						break;
					case 'alias':
						fieldAlias= (tag.comment as string|undefined)?.trim().split(/\s/, 1)[0];
						break;
				}
			}
		}
		let comment= jsDoc.join("\n").trim() || undefined;
		// Switch type
		switch(node.kind){
			case ts.SyntaxKind.InterfaceDeclaration:
			case ts.SyntaxKind.ClassDeclaration:
				// Node name
				nodeName= (node as ts.ClassDeclaration).name?.getText();
				// Check has "export" keyword
				if(!(node.modifiers?.some(e=> e.kind=== ts.SyntaxKind.ExportKeyword))){
					warn(`PARSER>> Missing "export" keyword on ${nodeType.isClass()? 'class': 'interface'}: ${nodeName} at ${_errorFile(srcFile, node)}`);
					continue rootLoop;
				}
				// Check for heritage clause
				let classNode= node as ts.ClassDeclaration;
				let inherited: Reference[]= [];
				let clauses= classNode.heritageClauses;
				if(clauses!=null){
					for(let i=0, len= clauses.length; i<len; ++i){
						let n= clauses[i].types;
						for(let j=0, jlen= n.length; j<jlen; ++j){
							let t= n[j];
							// Check for "ResolversOf" and "InputResolversOf"
							var s= typeChecker.getSymbolAtLocation(t.expression);
							var txt= s?.name;
							if(txt==null) throw new Error(`Could not resolve type "${t.expression.getText()}" at ${_errorFile(srcFile, node)}`);
							// Resolve subtypes
							if(txt === 'ResolversOf' || txt==='InputResolversOf'){
								let nName= typeChecker.getSymbolAtLocation((t.typeArguments![0] as ts.TypeReferenceNode).typeName)?.name;
								if(nName==null){
									warns.push(`Could not resolve type "${t.typeArguments![0].getText()}" at ${nodeName} ${_errorFile(srcFile, node)}`);
									continue rootLoop;
								}
								nodeName= nName;
								isInput= txt=== 'InputResolversOf';
							} else {
								let nRef: Reference= {
									kind:		ModelKind.REF,
									fileName:	srcFile.fileName,
									name:		txt!,
									params:		t.typeArguments==null? undefined: []
								};
								visitor.push(t.typeArguments, nRef, srcFile);
								inherited.push(nRef);
							}
						}
					}
					// Add to comment
					jsDoc.push(...clauses.map(e=> `\n@${e.getText()}`));
					comment= jsDoc.join("\n");
				}
				// Visible fields
				let cChilds= nodeType.getProperties();
				let visibleFields:PlainObject['visibleFields']= new Map();
				for(let i=0, len= cChilds.length; i<len; ++i){
					let s= cChilds[i];
					let clName= ((s.valueDeclaration ?? s.declarations?.[0])?.parent as ts.ClassDeclaration).name?.getText();
					if(clName==null) throw new Error(`unknown classname of inherited field "${nodeName}.${s.name}" at: ${_errorFile(srcFile, node)}`);
					visibleFields.set(s.name, {flags: s.flags, className: clName});
				}
				// Add Entity
				if(nodeName==null) throw new Error(`Missing entity name at ${_errorFile(srcFile, node)}`);
				let entity= ROOT.get(nodeName) as PlainObject;
				if(entity==null){
					// Add Generic params
					let generics: string[]|undefined;
					let tpParams= classNode.typeParameters
					if(tpParams!=null){
						generics= [];
						for(let i=0, len= tpParams.length; i<len; ++i){
							generics.push(tpParams[i].name.getText());
						}
					}
					// Entity
					entity= {
						kind:		ModelKind.PLAIN_OBJECT,
						name:		nodeName,
						escapedName: nodeName,
						id:			idIt++,
						jsDoc:		comment,
						deprecated:	deprecated,
						fields:		new Map(),
						inherit:	inherited.length===0? undefined : inherited,
						generics:	generics,
						visibleFields: visibleFields,
						fileName:	srcFile.fileName,
						ownedFields:	0
					};
					ROOT.set(nodeName, entity);
				} else if(entity.kind !== ModelKind.PLAIN_OBJECT){
					throw new Error(`Entities with different types and same name "${nodeName}". last one at ${_errorFile(srcFile, node)}`);
				} else {
					if(inherited.length) (entity.inherit ??=[]).push(...inherited);
					entity.jsDoc ??= comment;
					entity.deprecated??= deprecated;
					visibleFields.forEach((v, k)=> {
						entity.visibleFields.set(k, v);
					});
				}
				// Go through properties
				visitor.push(classNode.members, entity, srcFile, isInput);
				break;
			case ts.SyntaxKind.PropertyDeclaration:
			case ts.SyntaxKind.PropertySignature:
				if(pDesc==null) continue;
				if(
					pDesc.kind !== ModelKind.PLAIN_OBJECT
					&& pDesc.kind !== ModelKind.OBJECT_LITERAL
				) continue;
				let propertyNode= (node as ts.PropertyDeclaration);
				nodeName= propertyNode.name?.getText();
				// Get field
				let pField= pDesc.fields.get(nodeName);
				if(pField==null){
					pField= {
						alias:		fieldAlias,
						input:		undefined,
						output:		undefined,
						idx:		pDesc.ownedFields++,
						className:	propertyNode.parent.name?.getText()
					};
					pDesc.fields.set(nodeName, pField);
				} else {
					//* Field alias
					if(pField.alias==null) pField.alias= fieldAlias;
					else if(pField.alias!== fieldAlias) throw new Error(`Field ${nodeName} could not have two aliases. got "${pField.alias}" and "${fieldAlias}" at ${_errorFile(srcFile, node)}`);
				}
				if(isInput!==true){
					//* Output field
					let f= pField.output;
					if(f==null){
						f={
							kind:		ModelKind.OUTPUT_FIELD,
							alias:		fieldAlias,
							name:		nodeName,
							id:			idIt++,
							deprecated:	deprecated,
							jsDoc:		comment,
							required:	!propertyNode.questionToken,
							// type:		undefined,
							param:		undefined,
							method:		undefined,
							fileName:	srcFile.fileName
						} as OutputField;
						pField.output= f;
					} else {
						f.deprecated??= deprecated;
						f.jsDoc??= comment;
						f.alias??= fieldAlias;
					}
					// Resolve type
					visitor.push(propertyNode.type, f, srcFile);
				}
				if(isInput!==false){
					//* Input field
					let f= pField.input;
					if(f==null){
						f= {
							kind:			ModelKind.INPUT_FIELD,
							name:			nodeName,
							id:				idIt++,
							alias:			fieldAlias,
							deprecated:		deprecated,
							jsDoc:			comment,
							required:		!propertyNode.questionToken,
							asserts:		_compileAsserts(asserts, undefined, srcFile),
							defaultValue:	defaultValue,
							validate:		undefined,
							fileName:		srcFile.fileName
						} as InputField;
						pField.input= f;
					} else {
						f.deprecated ??= deprecated;
						f.alias??= fieldAlias;
						f.jsDoc??= comment;
						f.asserts= _compileAsserts(asserts, f.asserts, srcFile)
					}
					visitor.push(propertyNode.type, f, srcFile);
				}
				break;
			case ts.SyntaxKind.MethodDeclaration:
				if(pDesc==null) continue;
				if(
					pDesc.kind !== ModelKind.PLAIN_OBJECT
					// && pDesc.kind !== ModelKind.OBJECT_LITERAL
				) continue;
				let methodNode= node as ts.MethodDeclaration;
				let parentNameNode= (methodNode.parent as ts.ClassDeclaration).name?.getText();
				if(parentNameNode==null)
					throw new Error(`Expected a class as parent for "${nodeName}" at ${_errorFile(srcFile, node)}`);
				nodeName= methodNode.name?.getText();
				// Get field
				let field= pDesc.fields.get(nodeName);
				if(field==null){
					field= {
						alias:	fieldAlias,
						input:	undefined,
						output:	undefined,
						idx:	pDesc.ownedFields++,
						className:	parentNameNode
					};
					pDesc.fields.set(nodeName, field);
				} else {
					//* Field alias
					if(field.alias==null) field.alias= fieldAlias;
					else if(field.alias!== fieldAlias) throw new Error(`Field ${nodeName} could not have two aliases. got "${field.alias}" and "${fieldAlias}" at ${_errorFile(srcFile, node)}`);
				}
				let method: MethodDescriptor= {
					fileName:	srcFile.fileName,
					className:	parentNameNode,
					name:		nodeName,
					isStatic:	node.modifiers?.some(n=> n.kind===ts.SyntaxKind.StaticKeyword) ?? false
				};
				let inpOut: InputField | OutputField | undefined
				if(isInput===true){
					//* Input validator
					inpOut= field.input;
					if(inpOut==null){
						inpOut= {
							kind:			ModelKind.INPUT_FIELD,
							alias:			fieldAlias,
							name:			nodeName,
							id:				idIt++,
							deprecated:		deprecated,
							jsDoc:			comment,
							required:		!(node as ts.PropertyDeclaration).questionToken,
							asserts:		_compileAsserts(asserts, undefined, srcFile),
							defaultValue:	defaultValue,
							validate:		method,
							fileName: 		srcFile.fileName
						} as InputField;
						field.input= inpOut;
					} else {
						inpOut.deprecated ??= deprecated;
						inpOut.jsDoc??= comment;
						inpOut.asserts= _compileAsserts(asserts, inpOut.asserts, srcFile);
						inpOut.validate= method;
						inpOut.alias??= fieldAlias;
					}
				} else {
					//* Output resolver
					inpOut= field.output;
					if(inpOut==null){
						inpOut={
							kind:		ModelKind.OUTPUT_FIELD,
							name:		nodeName,
							id:			idIt++,
							alias:		fieldAlias,
							deprecated:	deprecated,
							jsDoc:		comment,
							required:	!(node as ts.PropertyDeclaration).questionToken,
							// type:		undefined,
							param:		undefined,
							method:		method,
							fileName:	srcFile.fileName
						} as OutputField;
						field.output= inpOut;
					} else {
						inpOut.deprecated??= deprecated;
						inpOut.jsDoc??= comment;
						inpOut.method= method;
						inpOut.alias??= fieldAlias;
					}
					// Resolve parameter
					let params = (node as ts.MethodDeclaration).parameters;
					if (params?.[1]!=null)
						visitor.push(params[1], inpOut, srcFile);
				}
				// Go through results
				let tp= (node as ts.MethodDeclaration).type;
				// TODO generate type from return value of methods
				// (typeChecker.getReturnTypeOfSignature(typeChecker.getSignatureFromDeclaration(node as ts.MethodDeclaration)!).symbol?.declarations?.[0])
				// typeChecker.getBaseTypes
				if(tp==null){
					// let t= (typeChecker.getReturnTypeOfSignature(typeChecker.getSignatureFromDeclaration(node as ts.MethodDeclaration)!).symbol?.declarations?.[0])
					// let t= typeChecker.getSignaturesOfType(nodeType, ts.SignatureKind.Call);
					warns.push(`Please define return type for method "${nodeName}" at ${_errorFile(srcFile, node)}`);
				} else {
					visitor.push(tp, inpOut, srcFile);
				}
				break;
			case ts.SyntaxKind.Parameter:
				if(pDesc==null ||  pDesc.kind !== ModelKind.OUTPUT_FIELD )
					throw new Error(`Expected parent as method. Got ${pDesc?ModelKind[pDesc.kind]: 'nothing'} at ${_errorFile(srcFile, node)}\n${node.getText()}`);
				let paramNode= node as ts.ParameterDeclaration;
				nodeName= paramNode.name?.getText();
				let pRef: Param= {
					kind:		ModelKind.PARAM,
					name:		nodeName,
					id:			idIt++,
					deprecated:	deprecated,
					jsDoc:		comment,
					type:		undefined,
					fileName:	srcFile.fileName
				};
				pDesc.param= pRef;
				// Parse param type
				visitor.push(paramNode.type, pRef, srcFile);
				break;
			case ts.SyntaxKind.EnumDeclaration:
				let enumNode= node as ts.EnumDeclaration;
				nodeName= (node as ts.EnumDeclaration).name?.getText();
				// Check has "export" keyword
				if(!(node.modifiers?.some(e=> e.kind=== ts.SyntaxKind.ExportKeyword))){
					warn(`PARSER>> Missing "export" keyword on ENUM: ${nodeName} at ${_errorFile(srcFile, node)}`);
					continue rootLoop;
				}
				// Check for duplicate
				if(ROOT.has(nodeName)) throw new Error(`Duplicate ENUM "${nodeName}" at: ${_errorFile(srcFile, node)}`);
				let enumEntity: Enum= {
					kind:		ModelKind.ENUM,
					name:		nodeName,
					id:			idIt++,
					deprecated:	deprecated,
					jsDoc:		comment,
					members:	[],
					fileName:	srcFile.fileName
				};
				ROOT.set(nodeName, enumEntity);
				visitor.push(node.getChildren(), enumEntity, srcFile);
				break;
			case ts.SyntaxKind.EnumMember:
				//* Enum member
				nodeName= (node as ts.EnumMember).name?.getText();
				if(pDesc==null || pDesc.kind!=ModelKind.ENUM) throw new Error(`Enexpected ENUM MEMBER "${nodeName}" at: ${_errorFile(srcFile, node)}`);
				let enumMember: EnumMember= {
					kind:		ModelKind.ENUM_MEMBER,
					name:		nodeName,
					id:			idIt++,
					value:		typeChecker.getConstantValue(node as ts.EnumMember)!,
					deprecated:	deprecated,
					jsDoc:		comment,
					fileName:	srcFile.fileName
				}
				pDesc.members.push(enumMember);
				break;
			case ts.SyntaxKind.VariableStatement:
				// SCALARS, UNIONS
				let variableNode= node as ts.VariableStatement;
				let declarations= variableNode.declarationList.declarations;
				for(let i=0, len=declarations.length; i<len; ++i){
					let declaration= declarations[i];
					let type= declaration.type;
					let nodeName= declaration.name.getText();
					// Check for duplicate entity
					let s: ts.Symbol | undefined;
					if(
						type
						&& ts.isTypeReferenceNode(type)
						&& type.typeArguments?.length===1
						&& (s= typeChecker.getSymbolAtLocation(type.typeName))
					){
						let typeArg= type.typeArguments[0];
						let fieldName= typeArg.getText();
						switch(s.name){
							case 'ModelScalar':
								//* Scalar
								if(!ts.isTypeReferenceNode(typeArg))
									throw new Error(`Enexpected scalar name: "${fieldName}" at ${srcFile.fileName}:${typeArg.getStart()}`);
								if(ROOT.has(fieldName))
									throw new Error(`Already defined entity ${fieldName} at ${srcFile.fileName}:${typeArg.getStart()}`);
								let scalarEntity: Scalar= {
									kind:		ModelKind.SCALAR,
									name:		fieldName,
									id:			idIt++,
									deprecated: deprecated,
									jsDoc:		comment,
									parser: {
										fileName:	srcFile.fileName,
										className:  nodeName,
										isStatic:	true,
										name:		undefined
									},
									fileName:	srcFile.fileName
								};
								ROOT.set(fieldName, scalarEntity);
								break;
							case 'UNION':
								//* UNION
								if(!ts.isTypeReferenceNode(typeArg))
									throw new Error(`Enexpected UNION name: "${fieldName}" at ${srcFile.fileName}:${typeArg.getStart()}`);
								if(ROOT.has(fieldName))
									throw new Error(`Already defined entity ${fieldName} at ${srcFile.fileName}:${typeArg.getStart()}`);
								let unionNode: Union={
									kind:		ModelKind.UNION,
									name:		fieldName,
									id:			idIt++,
									deprecated:	deprecated,
									jsDoc:		comment,
									types:		[],
									parser: {
										fileName:	srcFile.fileName,
										className:	nodeName,
										isStatic:	true,
										name:		undefined
									},
									fileName:	srcFile.fileName
								};
								ROOT.set(fieldName, unionNode);
								let unionChilds= unionNode.types;
								// Parse members
								const union= typeChecker.getAliasedSymbol(
									typeChecker.getSymbolAtLocation(typeArg.typeName)!
								)?.declarations?.[0]
								?.getChildren().find(e=> e.kind===ts.SyntaxKind.UnionType);
								if(union==null || !ts.isUnionTypeNode(union))
									throw new Error(`Missing union types for: "${typeArg.getText()}" at ${typeArg.getSourceFile().fileName}:${typeArg.getStart()}`);
								else {
									let unionTypes= union.types;
									for(let k=0, klen= unionTypes.length; k<klen; ++k){
										let unionType= unionTypes[k];
										let dec= typeChecker.getTypeAtLocation(unionType).symbol?.declarations?.[0];
										if(dec==null || !(ts.isInterfaceDeclaration(dec) || ts.isClassDeclaration(dec)))
											throw new Error(`Illegal union type: ${dec?.getText()??typeArg.getText()} at ${typeArg.getSourceFile().fileName}:${typeArg.getStart()}`)
										else {
											let ref: Reference={
												kind:	ModelKind.REF,
												name:	dec.name!.getText(),
												fileName: srcFile.fileName,
												// TODO add support for Generic types in union
												params:		undefined
											};
											unionChilds.push(ref);
										}
									}
								}
								break;
						}
					}
				}
				break;
			case ts.SyntaxKind.TypeLiteral:
				//* Type literal are equivalent to nameless classes
				if(pDesc==null) continue;
				if(
					pDesc.kind !== ModelKind.OUTPUT_FIELD
					&& pDesc.kind !== ModelKind.INPUT_FIELD
					&& pDesc.kind !== ModelKind.LIST
					&& pDesc.kind !== ModelKind.PARAM
				) continue;
				let typeLiteral: ObjectLiteral= {
					kind:		ModelKind.OBJECT_LITERAL,
					name:		undefined,
					id:			idIt++,
					deprecated:	deprecated,
					jsDoc:		comment,
					fields:		new Map(),
					fileName:	srcFile.fileName,
					ownedFields: 0
				};
				let typeRef: Reference= {
					kind:		ModelKind.REF,
					name:		'',
					fileName:	srcFile.fileName,
					params:		undefined
				};
				namelessEntities.push({
					name:	(pDesc as OutputField).name,
					node:	typeLiteral,
					ref:	typeRef
				});
				pDesc.type= typeRef;
				// Go through fields
				visitor.push(node.getChildren(), typeLiteral, srcFile);
				break;
			case ts.SyntaxKind.UnionType:
				if(pDesc==null) continue;
				if(
					pDesc.kind !== ModelKind.OUTPUT_FIELD
					&& pDesc.kind !== ModelKind.INPUT_FIELD
					&& pDesc.kind !== ModelKind.LIST
					&& pDesc.kind !== ModelKind.PARAM
				) continue;
				let unionType:ts.TypeNode|undefined= undefined;
				(node as ts.UnionTypeNode).types.forEach(n=>{
					if(n.kind===ts.SyntaxKind.UndefinedKeyword)
						(pDesc as InputField|OutputField).required= false;
					else if(unionType==null)
						unionType= n;
					else
						throw new Error(`Please give a name to the union "${node.getText()}" at: ${_errorFile(srcFile, node)}`);
				});
				if(unionType!=null)
					visitor.push(unionType, pDesc, srcFile);
				break;
			case ts.SyntaxKind.TypeReference:
				if(pDesc==null) continue;
				if(
					pDesc.kind !== ModelKind.OUTPUT_FIELD
					&& pDesc.kind !== ModelKind.INPUT_FIELD
					&& pDesc.kind !== ModelKind.LIST
					&& pDesc.kind !== ModelKind.REF
					&& pDesc.kind !== ModelKind.PARAM
				) continue;
				// Ignore promise
				if(nodeType.getSymbol()?.name === 'Promise'){
					visitor.push((node as ts.TypeReferenceNode).typeArguments!, pDesc, srcFile);
					continue;
				}
				// Add reference
				let targetRef= (node as ts.TypeReferenceNode);
				let refEnt: Reference={
					kind:		ModelKind.REF,
					fileName:	srcFile.fileName,
					name:		targetRef.typeName.getText(), // referenced node's name
					params:		targetRef.typeArguments==null ? undefined : []
				};
				if(pDesc.kind===ModelKind.REF)
					pDesc.params!.push(refEnt);
				else
					pDesc.type= refEnt;
				// Resolve types
				visitor.push(targetRef.typeArguments, refEnt, srcFile);
				break;
			case ts.SyntaxKind.StringKeyword:
			case ts.SyntaxKind.BooleanKeyword:
			case ts.SyntaxKind.NumberKeyword:
			case ts.SyntaxKind.SymbolKeyword:
			case ts.SyntaxKind.BigIntKeyword:
				if(pDesc==null) continue;
				if(
					pDesc.kind !== ModelKind.OUTPUT_FIELD
					&& pDesc.kind !== ModelKind.INPUT_FIELD
					&& pDesc.kind !== ModelKind.LIST
					&& pDesc.kind !== ModelKind.REF
					&& pDesc.kind !== ModelKind.PARAM
				) continue;
				let basicScalarRef: Reference= {
					kind:	ModelKind.REF,
					name:	node.getText(),
					fileName:	srcFile.fileName,
					params: undefined
				}
				if(pDesc.kind===ModelKind.REF)
					pDesc.params!.push(basicScalarRef);
				else
					pDesc.type= basicScalarRef;
				break;
			case ts.SyntaxKind.ArrayType:
				if(pDesc==null) continue;
				if(
					pDesc.kind !== ModelKind.OUTPUT_FIELD
					&& pDesc.kind !== ModelKind.INPUT_FIELD
					&& pDesc.kind !== ModelKind.LIST
					&& pDesc.kind !== ModelKind.REF
					&& pDesc.kind !== ModelKind.PARAM
				) continue;
				let arrTpe: List= {
					kind:		ModelKind.LIST,
					id:			idIt++,
					required:	true,
					deprecated:	deprecated,
					jsDoc:		comment,
					fileName:	srcFile.fileName
				} as List;
				if(pDesc.kind===ModelKind.REF)
					pDesc.params!.push(arrTpe);
				else
					pDesc.type= arrTpe;
				// Visite childs
				visitor.push((node as ts.ArrayTypeNode).elementType, arrTpe, srcFile);
				break;
			case ts.SyntaxKind.TypeOperator:
				//FIXME check what TypeOperatorNode means?
				visitor.push((node as ts.TypeOperatorNode).type, pDesc, srcFile);
				break;
			case ts.SyntaxKind.SyntaxList:
				visitor.push(node.getChildren(), pDesc, srcFile);
				break
			case ts.SyntaxKind.TupleType:
				throw new Error(`Tuples are insupported, did you mean Array of type? at ${_errorFile(srcFile, node)}\n${node.getText()}`);
		}
	}
	if(warns.length)
		throw new Error(warns.join("\n"));
	//* STEP 2: ADD DEFAULT SCALARS
	for(let i=0, len=  DEFAULT_SCALARS.length; i<len; ++i){
		let fieldName= DEFAULT_SCALARS[i];
		if(!ROOT.has(fieldName)){
			let scalarNode: BasicScalar={
				kind: ModelKind.BASIC_SCALAR,
				name: fieldName
			};
			ROOT.set(fieldName, scalarNode);
		}
	}
	//* Resolve nameless entities
	const namelessMap:Map<string, number>= new Map();
	for(let i=0, len= namelessEntities.length; i<len; ++i){
		let item= namelessEntities[i];
		let itemName= item.name??'Entity';
		let tmpn= itemName;
		let itemI= namelessMap.get(tmpn) ?? 0;
		while(ROOT.has(itemName)){
			++itemI;
			itemName= `${tmpn}_${itemI}`;
		}
		namelessMap.set(tmpn, itemI);
		let nNode= item.node;
		nNode.name= itemName;
		ROOT.set(itemName, nNode);
		item.ref.name= itemName;
		// Set fields class name
		if(nNode.kind===ModelKind.OBJECT_LITERAL){
			nNode.fields.forEach(function(field){
				field.className= itemName;
			});
		}
	}
	return ROOT;
}

/** Nameless entities */
interface NamelessEntity{
	/** Proposed name or prefix */
	name:	string|undefined
	/** Target entity */
	node:	Node
	/** Target reference */
	ref:	Reference
}

/** Compile assert expressions */
function _compileAsserts(asserts: string[], prevAsserts: AssertOptions|undefined, srcFile: ts.SourceFile): AssertOptions|undefined {
	try{
		if(asserts.length){
			prevAsserts= Object.assign(prevAsserts ?? {}, ...asserts.map(e=> parseJSON(e)));
		}
		return prevAsserts;
	}catch(err){
		throw new Error(`Fail to parse assert arguments at ${srcFile.fileName}\n${asserts.join("\n")}\n${err?.stack}`);
	}
}

/** Generate error */
function _errorFile(srcFile: ts.SourceFile, node: ts.Node){
	let {line, character}= srcFile.getLineAndCharacterOfPosition(node.getStart());
	return `${srcFile.fileName}:${line}:${character}`;
}