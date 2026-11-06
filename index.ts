import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { Effect, JsonSchema, Schema, SchemaIssue, SchemaRepresentation } from "effect"

export const name = "structured_output"

const INSTRUCTION = `IMPORTANT: The user has requested structured output. You MUST use the ${name} tool for your final response. Do not respond with plain text. Finish any research and other tool calls first, then call ${name} exactly once. Its arguments are the final answer and must match the tool's schema. After it succeeds, stop.`

const description = `Return the final response as JSON matching the schema.

Call this tool exactly once, only after other work is finished.
- The arguments are the structured answer, not a wrapper around it
- They must validate against the schema
- After this tool succeeds, do not call tools or add commentary`

const UNAVAILABLE = `The user requested structured output, but the ${name} tool is not available. Tell them structured output could not be produced.`

const UNUSABLE = `The user requested structured output, but metadata.outputSchema is not a JSON object schema this tool can validate. Tell them the schema was rejected.`

const NOT_REQUESTED = "Structured output was not requested for the latest user message. Continue without this tool."

const UNREADABLE = "Could not read the session to validate structured output."

// Execution validates the schema registered here, not the schema a context hook shows the model.
// Keep this one permissive and check the caller's schema in execute.
const PERMISSIVE = {
  type: "object",
  additionalProperties: true,
} as const satisfies JsonSchema.JsonSchema

type Draft = "draft-07" | "2020-12"

type Requested =
  | { readonly type: "absent" }
  | { readonly type: "invalid" }
  | { readonly type: "schema"; readonly schema: JsonSchema.JsonSchema; readonly codec: Schema.Codec<unknown> }

const formatIssue = SchemaIssue.makeFormatterDefault()

// A prompt requests structured output by putting a JSON object schema on metadata.
// After the session is idle, the completed structured_output tool call's state.input is the result.
//
// POST /api/session/:sessionID/prompt
// {
//   "text": "Research Anthropic and provide company info",
//   "metadata": {
//     "outputSchema": {
//       "type": "object",
//       "properties": {
//         "company": { "type": "string" },
//         "founded": { "type": "number" },
//         "products": { "type": "array", "items": { "type": "string" } }
//       },
//       "required": ["company", "founded"],
//       "additionalProperties": false
//     }
//   }
// }
export default Plugin.define({
  id: "opencode.structured-output",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name,
        description,
        options: { codemode: false },
        input: PERMISSIVE,
        async execute(input, context) {
          const found = await load(ctx.session, context.sessionID)
          if (found.type !== "schema") throw new Error(NOT_REQUESTED)
          await accept(found.codec, input)
          return {
            content: "Structured output captured successfully.",
            metadata: { valid: true },
          }
        },
      })
    })

    await ctx.session.hook("context", async (event) => {
      try {
        present(event, await load(ctx.session, event.sessionID))
      } catch (cause) {
        console.warn("failed to load structured output schema", event.sessionID, cause)
        delete event.tools[name]
      }
    })
    // Compaction and generate share the tool snapshot but have their own hooks. Hide the tool there;
    // a context hook cannot add it back, and those calls are not the user's answer.
    await ctx.session.hook("compaction", (event) => {
      delete event.tools[name]
    })
    await ctx.session.hook("generate", (event) => {
      delete event.tools[name]
    })
  },
})

async function load(session: Context["session"], sessionID: string) {
  try {
    const messages = await session.context({ sessionID })
    return requested(messages.findLast((message) => message.type === "user")?.metadata)
  } catch (cause) {
    throw new Error(UNREADABLE, { cause })
  }
}

function requested(metadata: Record<string, unknown> | undefined): Requested {
  if (metadata === undefined || !Object.hasOwn(metadata, "outputSchema")) return { type: "absent" }
  const raw = metadata.outputSchema
  if (!isRecord(raw) || (raw.type !== undefined && raw.type !== "object")) return { type: "invalid" }
  const draft = draftOf(raw)
  // The advertised schema is handed to the provider, which may edit it. Keep that off the stored message.
  const schema = cloneSchema(raw)
  if (!schema) return { type: "invalid" }
  const codec = compile(schema, draft)
  if (!codec) return { type: "invalid" }
  return { type: "schema", schema, codec }
}

function present(event: Pick<SessionContext, "tools" | "system">, found: Requested) {
  if (found.type === "absent") {
    delete event.tools[name]
    return
  }
  if (found.type === "invalid" || !event.tools[name]) {
    delete event.tools[name]
    event.system.push({ type: "text", text: found.type === "invalid" ? UNUSABLE : UNAVAILABLE })
    return
  }
  event.tools[name] = { description, input: found.schema }
  event.system.push({ type: "text", text: INSTRUCTION })
}

async function accept(codec: Schema.Codec<unknown>, value: unknown) {
  try {
    await Effect.runPromise(Schema.decodeUnknownEffect(codec)(value, { errors: "all", onExcessProperty: "error" }))
  } catch (cause) {
    const detail = isRecord(cause) && "issue" in cause ? formatIssue(cause.issue as SchemaIssue.Issue) : String(cause)
    throw new Error(
      [
        `Invalid arguments for tool "${name}":`,
        detail,
        "",
        "Arguments provided:",
        JSON.stringify(value, null, 2),
        "",
        "Update the arguments and call the tool again.",
      ].join("\n"),
    )
  }
}

function draftOf(schema: Record<string, unknown>): Draft {
  return (typeof schema.$schema === "string" && schema.$schema.includes("draft-07")) || "definitions" in schema
    ? "draft-07"
    : "2020-12"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function cloneSchema(schema: Record<string, unknown>): JsonSchema.JsonSchema | undefined {
  try {
    const copy = structuredClone(schema)
    if (!isRecord(copy)) return undefined
    if (!Object.hasOwn(copy, "$schema")) return copy
    const { $schema: _, ...rest } = copy
    return rest
  } catch {
    return undefined
  }
}

function compile(schema: JsonSchema.JsonSchema, preferred: Draft) {
  const order: ReadonlyArray<Draft> = preferred === "draft-07" ? ["draft-07", "2020-12"] : ["2020-12", "draft-07"]
  for (const draft of order) {
    const codec = compileDraft(schema, draft)
    if (codec) return codec
  }
}

function compileDraft(schema: JsonSchema.JsonSchema, draft: Draft) {
  try {
    const document =
      draft === "draft-07" ? JsonSchema.fromSchemaDraft07(schema) : JsonSchema.fromSchemaDraft2020_12(schema)
    // The schema comes from the session owner. Apply its patterns instead of rejecting patternProperties.
    return Schema.make<Schema.Codec<unknown>>(
      SchemaRepresentation.fromJsonSchemaDocument(document, { patterns: "apply" }).ast,
    )
  } catch {
    return undefined
  }
}
