# Delegation skill (Codex entrypoint)

When the user asks to delegate work ("delegate this", "have the executors build X", or any
handed-over task/story/project): read `SKILL.md` in this folder and follow it as your
operating procedure, applying the tool mapping from README.md's "Portability notes"
(you have no AskUserQuestion/Workflow/browser tools — use plain questions, sequential
review prompts, and `nohup`-detached relay processes with artifact polling instead).

Per-project settings live in `<repo>/.claude/delegate.config.json`; run the setup
interview from SKILL.md's Setup section when the file is missing, and honor it when
present.
