import ts from "typescript";
import { JsDocUtils } from "./jsdoc";
import { ModelInfo } from "./methods";

/** JSON types */
export type JSONTypes = boolean | string | number;

/** clone type */
export type ExtendsType<T> = T & {};

/** Create new Scalar */
export interface ScalarOptions<T> {
	/** Parse from JSON, could be undefined */
	parse?: (value: JSONTypes, parent: any, context: any, info: ModelInfo) => T | undefined
	/** Default input value */
	default?: (parent: any, context: any, info: ModelInfo) => T
	/** Default output value when parsing */
	defaultOutput?: (parent: any, context: any, info: ModelInfo) => T
	/** Serialize data */
	serialize?: (value: T, parent: any, context: any, info: ModelInfo) => JSONTypes | undefined
	/** convert data received from DB or any trusted source, could be undefined */
	fromDB?: (value: any, parent: any, context: any, info: ModelInfo) => T | undefined
	/** Convert data to be saved to DB or sent to trusted resource */
	toDB?: (value: T, parent: any, context: any, info: ModelInfo) => any
	/** Mock this value */
	mock?: (parent: any, context: any, info: ModelInfo) => T | undefined
	/**
	 * Parse "@assert" jsDoc annotation arguments into executable JS
	 */
	assertJsDocParser?: (value: string) => string | undefined // TODO add documentation
	/**
	 * Parse "@default" jsDoc annotation ito value
	 */
	defaultJsDocParser?: (value: string, utils: JsDocUtils) => DefaultParserResponse<T> | ts.Statement
}

/** Default parser */
export interface DefaultParserResponse<T> {
	/** Additional imports or any root statement */
	root?: string | ts.Statement | ts.Statement[],
	/** Default value generator */
	value: T | ts.Statement | undefined
}