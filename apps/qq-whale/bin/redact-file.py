#!/usr/bin/env python3
"""Redact credential fields without corrupting JSON or leaving YAML block secrets."""
import json, re, sys
from pathlib import Path

source, target = map(Path, sys.argv[1:3])
text = source.read_text(encoding='utf8')
secret = re.compile(r'api[_-]?key|secret|token|password|passwd|credential|appid|app_id|access[_-]?key', re.I)
replacement = '***已脱敏(no-secrets)***'
def clean(value):
    if isinstance(value, dict):
        return {k: replacement if secret.search(k) else clean(v) for k,v in value.items()}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value

# .raw is a staging suffix, so inspect the filename before that suffix.
suffix = Path(str(source).removesuffix('.raw')).suffix.lower()
if suffix == '.json' or text.lstrip().startswith(('{','[')):
    result = json.dumps(clean(json.loads(text)), ensure_ascii=False, indent=2)+'\n'
elif suffix == '.jsonl':
    result = '\n'.join(json.dumps(clean(json.loads(line)),ensure_ascii=False) for line in text.splitlines() if line.strip())+'\n'
else:
    lines=[]; skip_indent=None
    for line in text.splitlines():
        indent=len(line)-len(line.lstrip())
        if skip_indent is not None:
            if not line.strip() or indent > skip_indent:
                continue
            skip_indent=None
        match=re.match(r"^(\s*(?:- )?)(['\"]?)([^'\":=]+)\2\s*([:=])(.*)$",line)
        if match and secret.search(match[3]):
            lines.append(f"{match[1]}{match[2]}{match[3]}{match[2]}{match[4]} '{replacement}'")
            tail=match[5].strip()
            if not tail or tail.startswith(('|','>')):
                skip_indent=indent
        else:
            lines.append(line)
    result='\n'.join(lines)+'\n'
target.write_text(result,encoding='utf8')
target.chmod(0o600)
