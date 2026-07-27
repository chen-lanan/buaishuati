#!/usr/bin/env python3
from pathlib import Path
import json, shutil

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'miniapp-source'
OUT = ROOT / 'app/src/main/assets/web'
RUNTIME = ROOT / 'web-runtime'

OUT.mkdir(parents=True, exist_ok=True)

# Bundle JavaScript modules in a stable order.
order = json.loads((ROOT / 'tools/module-order.json').read_text(encoding='utf-8'))
chunks = []
for name in order:
    body = (SRC / name).read_text(encoding='utf-8').rstrip()
    chunks.append(f'__define("{name}", function(require, module, exports){{\n{body}\n}});')
(OUT / 'project-modules.js').write_text('\n'.join(chunks) + '\n', encoding='utf-8')

app_config = json.loads((SRC / 'app.json').read_text(encoding='utf-8'))
project = {
    'appConfig': app_config,
    'appStyle': (SRC / 'app.wxss').read_text(encoding='utf-8'),
    'pages': {}
}
for route in app_config['pages']:
    leaf = route.split('/')[-1]
    route_path = Path(route)
    folder = SRC / route_path.parent
    project['pages'][route] = {
        'template': (folder / f'{leaf}.wxml').read_text(encoding='utf-8'),
        'style': (folder / f'{leaf}.wxss').read_text(encoding='utf-8'),
        'config': json.loads((folder / f'{leaf}.json').read_text(encoding='utf-8'))
    }
(OUT / 'project-data.js').write_text(
    'window.__PROJECT__ = ' + json.dumps(project, ensure_ascii=False, separators=(',', ':')) + ';\n',
    encoding='utf-8'
)

for name in ['index.html', 'runtime.js', 'base.css', 'theme.css']:
    shutil.copy2(RUNTIME / name, OUT / name)
shutil.copy2(SRC / 'model/question-ai-model.js', OUT / 'question-ai-model.js')
static_assets = SRC / 'assets'
if static_assets.exists():
    target_assets = OUT / 'assets'
    if target_assets.exists():
        shutil.rmtree(target_assets)
    shutil.copytree(static_assets, target_assets)

print('Web assets rebuilt:', OUT)
