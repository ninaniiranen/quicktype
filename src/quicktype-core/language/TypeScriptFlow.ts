import { Type, ArrayType, UnionType, ClassType, EnumType } from "../Type";
import { matchType, nullableFromUnion, isNamedType } from "../TypeUtils";
import { utf16StringEscape, camelCase } from "../support/Strings";

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
import { RenderContext } from "../Renderer";
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

    private sourceFor(t: Type): MultiWord {
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

    protected importsForType(t: ClassType | UnionType | EnumType): ReadonlySet<Type> {
        return t.getChildren();
    }

    emitImports(imports: ReadonlySet<Type>): void {
        for (const type of imports) {
            this.emitLine("import ", type.getCombinedName(), " from './", type.getCombinedName(), "';");
        }
    }

    emitFileHeader(filename: Name, imports: ReadonlySet<Type>): void {
        this.startFile(filename);
        this.emitLine("// @flow");
        this.ensureBlankLine();
        this.emitImports(imports);
        this.ensureBlankLine();
    }

    protected emitClassDefinition(c: ClassType, className: Name): void {
        this.emitFileHeader(className, this.importsForType(c));
        this.emitDescription(this.descriptionForType(c));
        // this.emitClassAttributes(c, className);
        /* this.emitBlock(["public class ", className], () => {
            this.forEachClassProperty(c, "none", (name, _, p) => {
                this.emitLine("private ", this.javaType(false, p.type, true), " ", name, ";");
            });
            this.forEachClassProperty(c, "leading-and-interposing", (name, jsonName, p) => {
                this.emitDescription(this.descriptionForClassProperty(c, jsonName));
                const [getterName, setterName] = defined(this._gettersAndSettersForPropertyName.get(name));
                this.emitAccessorAttributes(c, className, name, jsonName, p, false);
                const rendered = this.javaType(false, p.type);
                this.emitLine("public ", rendered, " ", getterName, "() { return ", name, "; }");
                this.emitAccessorAttributes(c, className, name, jsonName, p, true);
                this.emitLine("public void ", setterName, "(", rendered, " value) { this.", name, " = value; }");
            });
        });
        */
        this.finishFile();
    }

    /*protected unionField(
        u: UnionType,
        t: Type,
        withIssues: boolean = false
    ): { fieldType: Sourcelike; fieldName: Sourcelike } {
        const fieldType = this.javaType(true, t, withIssues);
        // FIXME: "Value" should be part of the name.
        const fieldName = [this.nameForUnionMember(u, t), "Value"];
        return { fieldType, fieldName };
    }*/

    protected emitUnionDefinition(u: UnionType, unionName: Name): void {
        /*const tokenCase = (tokenType: string): void => {
            this.emitLine("case ", tokenType, ":");
        };

        const emitNullDeserializer = (): void => {
            tokenCase("VALUE_NULL");
            this.indent(() => this.emitLine("break;"));
        };

        const emitDeserializeType = (_t: Type): void => {
            const { fieldName } = this.unionField(u, t);
            const rendered = this.javaTypeWithoutGenerics(true, t);
            this.emitLine("value.", fieldName, " = jsonParser.readValueAs(", rendered, ".class);");
            this.emitLine("break;");
        };

        const emitDeserializer = (tokenTypes: string[], kind: TypeKind): void => {
            const t = u.findMember(kind);
            if (t === undefined) return;

            for (const tokenType of tokenTypes) {
                tokenCase(tokenType);
            }
            this.indent(() => emitDeserializeType(t));
        };

        const emitDoubleSerializer = (): void => {
            const t = u.findMember("double");
            if (t === undefined) return;

            if (u.findMember("integer") === undefined) tokenCase("VALUE_NUMBER_INT");
            tokenCase("VALUE_NUMBER_FLOAT");
            this.indent(() => emitDeserializeType(t));
        };*/

        this.emitFileHeader(unionName, this.importsForType(u));
        this.emitDescription(this.descriptionForType(u));
        if (!this._flowOptions.justTypes) {
            this.emitLine("@JsonDeserialize(using = ", unionName, ".Deserializer.class)");
            this.emitLine("@JsonSerialize(using = ", unionName, ".Serializer.class)");
        }
        /*const [maybeNull, nonNulls] = removeNullFromUnion(u);
        this.emitBlock(["public class ", unionName], () => {
            for (const t of nonNulls) {
                const { fieldType, fieldName } = this.unionField(u, t, true);
                this.emitLine("public ", fieldType, " ", fieldName, ";");
            }
            if (this._flowOptions.justTypes) return;
            this.ensureBlankLine();
            this.emitBlock(["static class Deserializer extends JsonDeserializer<", unionName, ">"], () => {
                this.emitLine("@Override");
                this.emitBlock(
                    [
                        "public ",
                        unionName,
                        " deserialize(JsonParser jsonParser, DeserializationContext deserializationContext) throws IOException, JsonProcessingException"
                    ],
                    () => {
                        this.emitLine(unionName, " value = new ", unionName, "();");
                        this.emitLine("switch (jsonParser.getCurrentToken()) {");
                        if (maybeNull !== null) emitNullDeserializer();
                        emitDeserializer(["VALUE_NUMBER_INT"], "integer");
                        emitDoubleSerializer();
                        emitDeserializer(["VALUE_TRUE", "VALUE_FALSE"], "bool");
                        emitDeserializer(["VALUE_STRING"], "string");
                        emitDeserializer(["START_ARRAY"], "array");
                        emitDeserializer(["START_OBJECT"], "class");
                        emitDeserializer(["VALUE_STRING"], "enum");
                        emitDeserializer(["START_OBJECT"], "map");
                        this.emitLine('default: throw new IOException("Cannot deserialize ', unionName, '");');
                        this.emitLine("}");
                        this.emitLine("return value;");
                    }
                );
            });
            this.ensureBlankLine();
            this.emitBlock(["static class Serializer extends JsonSerializer<", unionName, ">"], () => {
                this.emitLine("@Override");
                this.emitBlock(
                    [
                        "public void serialize(",
                        unionName,
                        " obj, JsonGenerator jsonGenerator, SerializerProvider serializerProvider) throws IOException"
                    ],
                    () => {
                        for (const t of nonNulls) {
                            const { fieldName } = this.unionField(u, t, true);
                            this.emitBlock(["if (obj.", fieldName, " != null)"], () => {
                                this.emitLine("jsonGenerator.writeObject(obj.", fieldName, ");");
                                this.emitLine("return;");
                            });
                        }
                        if (maybeNull !== null) {
                            this.emitLine("jsonGenerator.writeNull();");
                        } else {
                            this.emitLine('throw new IOException("', unionName, ' must not be null");');
                        }
                    }
                );
            });
        });*/
        this.finishFile();
    }

    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.emitFileHeader(enumName, this.importsForType(e));
        this.emitDescription(this.descriptionForType(e));
        const caseNames: Sourcelike[] = [];
        this.forEachEnumCase(e, "none", name => {
            if (caseNames.length > 0) caseNames.push(", ");
            caseNames.push(name);
        });
        caseNames.push(";");
        /*this.emitBlock(["public enum ", enumName], () => {
            this.emitLine(caseNames);
            this.ensureBlankLine();
            this.emitLine("@JsonValue");
            this.emitBlock("public String toValue()", () => {
                this.emitLine("switch (this) {");
                this.forEachEnumCase(e, "none", (name, jsonName) => {
                    this.emitLine("case ", name, ': return "', stringEscape(jsonName), '";');
                });
                this.emitLine("}");
                this.emitLine("return null;");
            });
            this.ensureBlankLine();
            this.emitLine("@JsonCreator");
            this.emitBlock(["public static ", enumName, " forValue(String value) throws IOException"], () => {
                this.forEachEnumCase(e, "none", (name, jsonName) => {
                    this.emitLine('if (value.equals("', stringEscape(jsonName), '")) return ', name, ";");
                });
                this.emitLine('throw new IOException("Cannot deserialize ', enumName, '");');
            });
        });*/
        this.finishFile();
    }

    protected emitSourceStructure(givenOutputFilename: string) {
        super.emitSourceStructure(givenOutputFilename);

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, n: Name) => this.emitClassDefinition(c, n),
            (e, n) => this.emitEnumDefinition(e, n),
            (u, n) => this.emitUnionDefinition(u, n)
        );
    }
}
