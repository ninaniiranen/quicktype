import {
    Type,
    ArrayType,
    UnionType,
    ClassType,
    EnumType,
    ObjectType /*ClassProperty*/,
    ClassProperty,
    MapType
} from "../Type";
import { matchType, nullableFromUnion, isNamedType } from "../TypeUtils";
import { utf16StringEscape, camelCase, pascalCase } from "../support/Strings";

import { Sourcelike, modifySource, MultiWord, singleWord, parenIfNeeded, multiWord } from "../Source";
import { Name, Namer, funPrefixNamer } from "../Naming";
import { BooleanOption, Option, OptionValues, getOptionValues } from "../RendererOptions";
import {
    javaScriptOptions,
    JavaScriptTargetLanguage,
    JavaScriptRenderer,
    JavaScriptTypeAnnotations,
    legalizeName,
    nameStyle
} from "./JavaScript";
import { defined, panic, assert } from "../support/Support";
import { TargetLanguage } from "../TargetLanguage";
import { RenderContext, ForEachPosition, BlankLineConfig } from "../Renderer";
import { isES3IdentifierStart } from "./JavaScriptUnicodeMaps";

export const tsFlowOptions = Object.assign({}, javaScriptOptions, {
    justTypes: new BooleanOption("just-types", "Interfaces only", false),
    nicePropertyNames: new BooleanOption("nice-property-names", "Transform property names to be JavaScripty", false),
    declareUnions: new BooleanOption("explicit-unions", "Explicitly name unions", false)
});

const tsFlowTypeAnnotations = {
    any: ": any",
    anyArray: ": any[]",
    anyMap: ": { [k: string]: any }",
    string: ": string",
    stringArray: ": string[]",
    boolean: ": boolean"
};

export abstract class TypeScriptFlowBaseTargetLanguage extends JavaScriptTargetLanguage {
    protected getOptions(): Option<any>[] {
        return [
            tsFlowOptions.justTypes,
            tsFlowOptions.nicePropertyNames,
            tsFlowOptions.declareUnions,
            tsFlowOptions.runtimeTypecheck
        ];
    }

    get supportsOptionalClassProperties(): boolean {
        return true;
    }

    protected abstract makeRenderer(
        renderContext: RenderContext,
        untypedOptionValues: { [name: string]: any }
    ): JavaScriptRenderer;
}

export class TypeScriptTargetLanguage extends TypeScriptFlowBaseTargetLanguage {
    constructor() {
        super("TypeScript", ["typescript", "ts", "tsx"], "ts");
    }

    protected makeRenderer(
        renderContext: RenderContext,
        untypedOptionValues: { [name: string]: any }
    ): TypeScriptRenderer {
        return new TypeScriptRenderer(this, renderContext, getOptionValues(tsFlowOptions, untypedOptionValues));
    }
}

function quotePropertyName(original: string): string {
    const escaped = utf16StringEscape(original);
    const quoted = `"${escaped}"`;

    if (original.length === 0) {
        return quoted;
    } else if (!isES3IdentifierStart(original.codePointAt(0) as number)) {
        return quoted;
    } else if (escaped !== original) {
        return quoted;
    } else if (legalizeName(original) !== original) {
        return quoted;
    } else {
        return original;
    }
}

const nicePropertiesNamingFunction = funPrefixNamer("properties", s => nameStyle(s, false));

export abstract class TypeScriptFlowBaseRenderer extends JavaScriptRenderer {
    constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _tsFlowOptions: OptionValues<typeof tsFlowOptions>
    ) {
        super(targetLanguage, renderContext, _tsFlowOptions);
    }

    protected namerForObjectProperty(): Namer {
        if (this._tsFlowOptions.nicePropertyNames) {
            return nicePropertiesNamingFunction;
        } else {
            return super.namerForObjectProperty();
        }
    }

    protected sourceFor(t: Type): MultiWord {
        if (["class", "object", "enum"].indexOf(t.kind) >= 0) {
            return singleWord(this.nameForNamedType(t));
        }
        return matchType<MultiWord>(
            t,
            _anyType => singleWord("any"),
            _nullType => singleWord("null"),
            _boolType => singleWord("boolean"),
            _integerType => singleWord("number"),
            _doubleType => singleWord("number"),
            _stringType => singleWord("string"),
            arrayType => {
                const itemType = this.sourceFor(arrayType.items);
                if (
                    (arrayType.items instanceof UnionType && !this._tsFlowOptions.declareUnions) ||
                    arrayType.items instanceof ArrayType
                ) {
                    return singleWord(["Array<", itemType.source, ">"]);
                } else {
                    return singleWord([parenIfNeeded(itemType), "[]"]);
                }
            },
            _classType => panic("We handled this above"),
            mapType => singleWord(["{ [key: string]: ", this.sourceFor(mapType.values).source, " }"]),
            _enumType => panic("We handled this above"),
            unionType => {
                if (!this._tsFlowOptions.declareUnions || nullableFromUnion(unionType) !== null) {
                    const children = Array.from(unionType.getChildren()).map(c => parenIfNeeded(this.sourceFor(c)));
                    return multiWord(" | ", ...children);
                } else {
                    return singleWord(this.nameForNamedType(unionType));
                }
            }
        );
    }

    protected abstract emitEnum(e: EnumType, enumName: Name): void;

    protected abstract emitClassBlock(c: ClassType, className: Name): void;

    protected emitClassBlockBody(c: ClassType): void {
        this.emitPropertyTable(c, (name, _jsonName, p) => {
            const t = p.type;
            return [
                [modifySource(quotePropertyName, name), p.isOptional ? "?" : "", ": "],
                [this.sourceFor(t).source, ";"]
            ];
        });
    }

    private emitClass(c: ClassType, className: Name) {
        this.emitDescription(this.descriptionForType(c));
        this.emitClassBlock(c, className);
    }

    emitUnion(u: UnionType, unionName: Name) {
        if (!this._tsFlowOptions.declareUnions) {
            return;
        }

        this.emitDescription(this.descriptionForType(u));

        const children = multiWord(" | ", ...Array.from(u.getChildren()).map(c => parenIfNeeded(this.sourceFor(c))));
        this.emitLine("export type ", unionName, " = ", children.source, ";");
    }

    protected emitTypes(): void {
        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, n: Name) => this.emitClass(c, n),
            (e, n) => this.emitEnum(e, n),
            (u, n) => this.emitUnion(u, n)
        );
    }

    protected emitUsageComments(): void {
        if (this._tsFlowOptions.justTypes) return;
        super.emitUsageComments();
    }

    protected deserializerFunctionLine(t: Type, name: Name): Sourcelike {
        return ["function to", name, "(json: string): ", this.sourceFor(t).source];
    }

    protected serializerFunctionLine(t: Type, name: Name): Sourcelike {
        const camelCaseName = modifySource(camelCase, name);
        return ["function ", camelCaseName, "ToJson(value: ", this.sourceFor(t).source, "): string"];
    }

    protected get moduleLine(): string | undefined {
        return undefined;
    }

    protected get castFunctionLines(): [string, string] {
        return ["function cast<T>(val: any, typ: any): T", "function uncast<T>(val: T, typ: any): any"];
    }

    protected get typeAnnotations(): JavaScriptTypeAnnotations {
        throw new Error("not implemented");
    }

    protected emitConvertModule(): void {
        if (this._tsFlowOptions.justTypes) return;
        super.emitConvertModule();
    }

    protected emitModuleExports(): void {
        if (this._tsFlowOptions.justTypes) {
            return;
        } else {
            super.emitModuleExports();
        }
    }
}

export class TypeScriptRenderer extends TypeScriptFlowBaseRenderer {
    protected forbiddenNamesForGlobalNamespace(): string[] {
        return ["Array", "Date"];
    }

    protected deserializerFunctionLine(t: Type, name: Name): Sourcelike {
        return ["export ", super.deserializerFunctionLine(t, name)];
    }

    protected serializerFunctionLine(t: Type, name: Name): Sourcelike {
        return ["export ", super.serializerFunctionLine(t, name)];
    }

    protected get moduleLine(): string | undefined {
        return "export namespace Convert";
    }

    protected get typeAnnotations(): JavaScriptTypeAnnotations {
        return Object.assign({ never: ": never" }, tsFlowTypeAnnotations);
    }

    protected emitModuleExports(): void {
        return;
    }

    protected emitUsageImportComment(): void {
        const topLevelNames: Sourcelike[] = [];
        this.forEachTopLevel(
            "none",
            (_t, name) => {
                topLevelNames.push(", ", name);
            },
            isNamedType
        );
        this.emitLine("//   import { Convert", topLevelNames, ' } from "./file";');
    }

    protected emitEnum(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));
        this.emitBlock(["export enum ", enumName, " "], "", () => {
            this.forEachEnumCase(e, "none", (name, jsonName) => {
                this.emitLine(name, ` = "${utf16StringEscape(jsonName)}",`);
            });
        });
    }

    protected emitClassBlock(c: ClassType, className: Name): void {
        this.emitBlock(["export interface ", className, " "], "", () => {
            this.emitClassBlockBody(c);
        });
    }
}

export const flowOptions = Object.assign({}, tsFlowOptions, {
    multiFileOutput: new BooleanOption("multi-file-output", "Output each type to it's own file", false)
});

export class FlowTargetLanguage extends TypeScriptFlowBaseTargetLanguage {
    constructor() {
        super("Flow", ["flow"], "js");
    }

    protected makeRenderer(renderContext: RenderContext, untypedOptionValues: { [name: string]: any }): FlowRenderer {
        return new FlowRenderer(this, renderContext, getOptionValues(flowOptions, untypedOptionValues));
    }
}

export class FlowRenderer extends TypeScriptFlowBaseRenderer {
    private _currentFilename: string | undefined;

    constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _flowOptions: OptionValues<typeof flowOptions>
    ) {
        super(targetLanguage, renderContext, _flowOptions);
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return ["Class", "Object", "String", "Array", "JSON", "Error"];
    }

    protected get typeAnnotations(): JavaScriptTypeAnnotations {
        return Object.assign({ never: "" }, tsFlowTypeAnnotations);
    }

    protected emitEnum(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));
        const lines: string[][] = [];
        this.forEachEnumCase(e, "none", (_, jsonName) => {
            const maybeOr = lines.length === 0 ? "  " : "| ";
            lines.push([maybeOr, '"', utf16StringEscape(jsonName), '"']);
        });
        defined(lines[lines.length - 1]).push(";");

        this.emitLine("export type ", enumName, " =");
        this.indent(() => {
            for (const line of lines) {
                this.emitLine(line);
            }
        });
    }

    protected emitClassBlock(c: ClassType, className: Name): void {
        this.emitBlock(["export type ", className, " = "], ";", () => {
            this.emitClassBlockBody(c);
        });
    }

    protected startFile(basename: Sourcelike): void {
        assert(this._currentFilename === undefined, "Previous file wasn't finished");
        // FIXME: The filenames should actually be Sourcelikes, too
        this._currentFilename = `${this.sourcelikeToString(basename)}.js`;
    }

    protected finishFile(): void {
        super.finishFile(defined(this._currentFilename));
        this._currentFilename = undefined;
    }

    protected sourceFor(t: Type): MultiWord {
        if (["class", "object", "enum"].indexOf(t.kind) >= 0) {
            return singleWord(modifySource(pascalCase, t.getCombinedName()));
        }
        return matchType<MultiWord>(
            t,
            _anyType => singleWord("any"),
            _nullType => singleWord("null"),
            _boolType => singleWord("boolean"),
            _integerType => singleWord("number"),
            _doubleType => singleWord("number"),
            _stringType => singleWord("string"),
            arrayType => {
                const itemType = this.sourceFor(arrayType.items);
                if (
                    (arrayType.items instanceof UnionType && !this._flowOptions.declareUnions) ||
                    arrayType.items instanceof ArrayType
                ) {
                    return singleWord(["Array<", itemType.source, ">"]);
                } else {
                    return singleWord([parenIfNeeded(itemType), "[]"]);
                }
            },
            _classType => panic("We handled this above"),
            mapType => singleWord(["{ [key: string]: ", this.sourceFor(mapType.values).source, " }"]),
            _enumType => panic("We handled this above"),
            unionType => {
                const children = Array.from(unionType.getChildren()).map(c => parenIfNeeded(this.sourceFor(c)));
                return multiWord(" | ", ...children);
            }
        );
    }

    protected importsForType(t: Type): ReadonlySet<Type> {
        console.log("imports:");
        if (t instanceof ObjectType) {
            // console.log(require("util").inspect(t));
            const referredTypes = new Set<Type>();
            t.getProperties().forEach((property, name) => {
                let type = property.type;
                if (type instanceof ArrayType) {
                    type = type.items;
                } else if (type instanceof MapType) {
                    type = type.values;
                }
                // console.log(require("util").inspect(type));
                property.graph.topLevels.forEach((topType, topName) => {
                    if (topType.structurallyCompatible(type)) {
                        referredTypes.add(type);
                    }
                });
            });
            return referredTypes;
        }
        return new Set<Type>();
    }

    emitImports(imports: ReadonlySet<Type>): void {
        for (const type of imports) {
            this.emitLine(
                "import { ",
                modifySource(pascalCase, type.getCombinedName()),
                " } from './",
                modifySource(camelCase, type.getCombinedName()),
                "';"
            );
        }
    }

    emitFileHeader(filename: Sourcelike, imports: ReadonlySet<Type>): void {
        this.startFile(filename);
        this.emitLine("// @flow");
        this.ensureBlankLine();
        this.emitImports(imports);
        this.ensureBlankLine();
    }

    emitTypes(): void {
        this.forEachTopLevel("leading-and-interposing", (type: Type, name: Name, position: ForEachPosition) =>
            this.emitTopLevel(type, name, position)
        );
    }

    emitProperties(type: ObjectType): void {
        this.forEachObjectProperty(type, "none", (p, n, _pos) => {
            const t = p.type;
            const source = [n, p.isOptional ? "?" : "", ": "];
            this.emitDescription(this.descriptionForType(t));
            this.emitLine(...source, this.sourceFor(t).source, ";");
            /*if (t instanceof ArrayType) {
                this.emitLine(...source, this.sourceFor(t).source, ";");
            } else if (t instanceof EnumType) {
                this.emitLine(...source, modifySource(pascalCase, t.getCombinedName()), ";");
                /*this.emitLine("export type ", t.getCombinedName(), " =");
                const lines: string[][] = [];
                this.forEachEnumCase(t, "none", (_, jsonName) => {
                    const maybeOr = lines.length === 0 ? "  " : "| ";
                    lines.push([maybeOr, '"', utf16StringEscape(jsonName), '"']);
                });
                defined(lines[lines.length - 1]).push(";");
                this.indent(() => {
                    for (const line of lines) {
                        this.emitLine(line);
                    }
                });
            }*/
        });

        /*
        type.getSortedProperties().forEach((prop, propName) => {
            if (prop.type instanceof ObjectType) {
                this.forEachClassProperty(prop.type, "leading-and-interposing", (n, _jn, p) => {
                    this.emitBlock(["    ", n, p.isOptional ? "?" : "", ":"], ";", () => {
                        this.sourceFor(p.type);
                    });
                });
            } else {
                this.emitBlock(["    ", propName, prop.isOptional ? "?" : "", ":"], ";", () => {
                    this.sourceFor(prop.type);
                });
            }
            if (prop.type instanceof ClassType) {
            this.emitPropertyTable(prop.type, (propName: Name, _jsonName: string, p: ClassProperty) => {
                const t = p.type;
                return [
                    [modifySource(quotePropertyName, propName), p.isOptional ? "?" : "", ": "],
                    [this.sourceFor(t).source, ";"]
                ];
            });
        }
        });*/
    }

    forEachObjectProperty(
        type: ObjectType,
        blackLineConfig: BlankLineConfig,
        f: (type: ClassProperty, name: string, position: ForEachPosition) => void
    ): void {
        const properties = type.getProperties();
        this.forEachWithBlankLines(properties, blackLineConfig, (property, name, pos) => {
            // const name = this.makeNameForNamedType(property.type);
            f(property, name, pos);
        });
    }

    emitSubObjects(type: ObjectType): void {
        this.forEachObjectProperty(type, "none", (p, _n, _pos) => {
            let isTopLevel = false;
            p.graph.topLevels.forEach((topType, _topName) => {
                if (topType.structurallyCompatible(p.type)) {
                    isTopLevel = true;
                }
            });
            if (isTopLevel) {
                return;
            }
            const t = p.type;
            // const source = [n, p.isOptional ? "?" : "", ": "];
            if (t instanceof ObjectType) {
                this.emitDescription(this.descriptionForType(t));
                this.emitBlock(["export type ", modifySource(pascalCase, t.getCombinedName()), " = "], ";", () => {
                    this.emitProperties(type);
                });
                this.ensureBlankLine();
            } else if (t instanceof EnumType) {
                this.emitDescription(this.descriptionForType(t));
                // this.emitLine(...source, modifySource(pascalCase, t.getCombinedName()), ";");
                this.emitLine("export type ", modifySource(pascalCase, t.getCombinedName()), " =");
                const lines: string[][] = [];
                this.forEachEnumCase(t, "none", (_, jsonName) => {
                    const maybeOr = lines.length === 0 ? "  " : "| ";
                    lines.push([maybeOr, '"', utf16StringEscape(jsonName), '"']);
                });
                defined(lines[lines.length - 1]).push(";");
                this.indent(() => {
                    for (const line of lines) {
                        this.emitLine(line);
                    }
                });
                this.ensureBlankLine();
            }
        });
    }

    emitTopLevel(type: Type, _name: Name, _position: ForEachPosition): void {
        if (type instanceof ObjectType) {
            this.emitFileHeader(modifySource(camelCase, type.getCombinedName()), this.importsForType(type));
            this.emitDescription(this.descriptionForType(type));
            this.emitBlock(["export type ", modifySource(pascalCase, type.getCombinedName()), " = "], ";", () => {
                this.emitProperties(type);
            });
            this.ensureBlankLine();
            this.emitSubObjects(type);
            this.finishFile();
        } else {
            console.warn(`skipping top level ${type.getCombinedName}`);
        }
    }

    protected emitSourceStructure(givenOutputFilename: string) {
        if (this._flowOptions) {
            super.emitSourceStructure(givenOutputFilename);
        }
    }
}
