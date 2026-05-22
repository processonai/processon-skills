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

3. Configure either:

- the `processon-diagrams` MCP server
- or `PROCESSON_API_KEY` for script fallback

4. Open the corresponding skill README for detailed capabilities, configuration, and prompt examples.

## Install Example

Install `processon-diagram-generator`:

```bash
npx skills add https://github.com/processonai/processon-skills.git --skill processon-diagram-generator
```

## Repository Layout

```text
processon-skills/
  README.md
  README.en.md
  LICENSE
  .gitignore
  skills/
    processon-diagram-generator/
      SKILL.md
      README.md
      scripts/
        processon_api_client.py
```

## Notes

- Skill discovery depends on each skill directory containing a valid `SKILL.md`.
- Keep public interface names stable:
  - skill name: `processon-diagram-generator`
  - MCP server name: `processon-diagrams`
  - env var: `PROCESSON_API_KEY`

For usage details, configuration examples, and host-compatibility guidance, see [skills/processon-diagram-generator/README.md](./skills/processon-diagram-generator/README.md).
