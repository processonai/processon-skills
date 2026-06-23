# ProcessOn Skills

[简体中文](./README.md)

This is a public multi-skill repository for ProcessOn-related AI diagram skills. The repository-level docs focus on installation and navigation, while each skill directory contains the detailed runtime behavior.

## Skills

| Skill | Docs |
| --- | --- |
| `processon-diagram-generator` | [skills/processon-diagram-generator/README.md](./skills/processon-diagram-generator/README.md) |
| `processon-mindmap-generator` | [skills/processon-mindmap-generator/README.md](./skills/processon-mindmap-generator/README.md) |
| `document-to-mindmap` | [skills/document-to-mindmap/README.md](./skills/document-to-mindmap/README.md) |

## Quick Start

1. Install a specific skill:

```bash
npx skills add https://github.com/processonai/processon-skills.git --skill processon-diagram-generator
```

2. Restart your host if it does not refresh installed skills automatically.

3. Complete browser authorization when the skill first runs. The diagram skill
   stores the returned token in the `processon-diagram-generator` mcporter
   configuration and connects through Streamable HTTP.

4. Open the corresponding skill README for detailed capabilities, configuration, and prompt examples.

## Install Example

Install `processon-diagram-generator`:

```bash
npx skills add https://github.com/processonai/processon-skills.git --skill processon-diagram-generator
```

## Notes

- Skill discovery depends on each skill directory containing a valid `SKILL.md`.
- Keep public interface names stable:
  - skill name: `processon-diagram-generator`
  - MCP server name: `processon-diagram-generator`

The diagram skill only supports browser authorization plus MCP. API-key script
fallback is no longer part of the runtime flow.

For usage details, configuration examples, and host-compatibility guidance, see [skills/processon-diagram-generator/README.md](./skills/processon-diagram-generator/README.md).
