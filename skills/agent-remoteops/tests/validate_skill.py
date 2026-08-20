from pathlib import Path
import re
import sys


skill = Path(__file__).parents[1]
skill_md = skill / "SKILL.md"
client = skill / "scripts" / "remoteops.py"
metadata = skill / "agents" / "openai.yaml"

errors = []
if not skill_md.is_file():
    errors.append("SKILL.md is missing")
else:
    content = skill_md.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n", content, re.DOTALL)
    if not match:
        errors.append("SKILL.md frontmatter is invalid")
    else:
        frontmatter = match.group(1)
        if not re.search(r"^name:\s*agent-remoteops\s*$", frontmatter, re.MULTILINE):
            errors.append("SKILL.md name is invalid")
        if not re.search(r"^description:\s*\S", frontmatter, re.MULTILINE):
            errors.append("SKILL.md description is missing")
    if "[TODO:" in content:
        errors.append("SKILL.md contains an unfinished TODO")

if not client.is_file():
    errors.append("Skill client script is missing")
if not metadata.is_file():
    errors.append("Codex metadata is missing")
elif "allow_implicit_invocation: true" not in metadata.read_text(encoding="utf-8"):
    errors.append("Codex implicit invocation is not enabled")

if errors:
    print("\n".join(errors), file=sys.stderr)
    raise SystemExit(1)
print("Skill is valid!")
