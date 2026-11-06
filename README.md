# Structured output

An opt-in OpenCode plugin. When a prompt includes `metadata.outputSchema`, the model is given a `structured_output` tool whose arguments are the JSON answer.

This package is not bundled with OpenCode and is not loaded automatically.

## Install

Install directly from Git:

```sh
opencode plugin add 'git+https://github.com/anomalyco/opencode.git#path:packages/plugins/structured-output'
```

The URL selects this directory and uses the repository's default branch. Installation is Git-only. The plugin exports `index.ts` directly. There is no build step.

For local development, add the directory to `plugins` in the project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./packages/plugins/structured-output"]
}
```

The plugin is not activated merely by being present in the repository. Installing it adds it to the user's configuration.

## Use

Pass a JSON object schema on the prompt. `type` may be `"object"` or omitted. `$schema` is removed before the model sees the schema.

```ts
await client.session.prompt({
  sessionID,
  text: "Research the company",
  metadata: {
    outputSchema: {
      type: "object",
      properties: {
        company: { type: "string" },
        founded: { type: "number" },
        products: { type: "array", items: { type: "string" } },
      },
      required: ["company", "founded"],
      additionalProperties: false,
    },
  },
})

await client.experimental.session.wait({ sessionID })

const messages = await client.message.list({ sessionID })
const answer = messages
  .flatMap((message) => (message.type === "assistant" ? message.content : []))
  .findLast(
    (part) => part.type === "tool" && part.name === "structured_output" && part.state.status === "completed",
  )?.state.input
```

`session.prompt` returns the admitted user message. The JSON is `state.input` on the completed `structured_output` tool call.

The tool is shown only for the latest user message that includes `outputSchema`. A later user message without it hides the tool. Compaction and title generation never see it. A schema that is not an object, or that this runtime cannot compile, is rejected and the tool is hidden. Draft-07 `$ref` into `definitions` is accepted. `additionalProperties: false` rejects extra fields so the model can retry.

The model is not forced to call the tool, and it can keep writing after a successful call. If it never calls `structured_output`, there is no JSON to read.

## Remove

```sh
opencode plugin remove 'git+https://github.com/anomalyco/opencode.git#path:packages/plugins/structured-output'
```

If you installed with a different Git specification, pass that same specification to remove it.
