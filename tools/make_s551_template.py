"""Build the S551 CAD template (layers, linetypes, lineweights, symbol blocks) from data/s551_layers.json.
Writes data/s551_template.dxf (AutoCAD 2000 DXF); ScanBench adds the survey linework into a copy of it."""
import json, ezdxf, os
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(here)
std = json.load(open(os.path.join(root, 'data', 's551_layers.json')))
doc = ezdxf.new('R2000', setup=['linetypes'])
doc.header['$INSUNITS'] = 6; doc.header['$MEASUREMENT'] = 1; doc.header['$LUNITS'] = 2; doc.header['$LUPREC'] = 3
if 'DASHED' not in doc.linetypes: doc.linetypes.add('DASHED', pattern=[0.75, 0.5, -0.25], description='Dashed __ __ __')
# symbol blocks, named as in the standard; simple stand-ins (insert the client's own template to get their exact symbols)
syms = sorted({r['symbol'] for r in std['layers'] if r['symbol']})
for s in syms:
    b = doc.blocks.new(name=s)
    if s == 'plus': b.add_line((-0.25, 0), (0.25, 0)); b.add_line((0, -0.25), (0, 0.25))
    elif s == '201':   # tree
        b.add_circle((0, 0), 0.5); b.add_line((-0.15, 0), (0.15, 0)); b.add_line((0, -0.15), (0, 0.15))
    else: b.add_circle((0, 0), 0.25); b.add_line((-0.15, 0), (0.15, 0)); b.add_line((0, -0.15), (0, 0.15)); b.add_text(s, dxfattribs={'height': 0.12, 'insert': (0.3, -0.06)})
for r in std['layers']:
    L = doc.layers.add(r['layer'], color=r['color'], linetype='DASHED' if r['linetype'] == 'DASHED' else 'CONTINUOUS')
    L.dxf.lineweight = int(round(r['lineweight'] * 100))
    L.description = r['code'] + ' - ' + r['description']
doc.saveas(os.path.join(root, 'data', 's551_template.dxf'))
d2 = ezdxf.readfile(os.path.join(root, 'data', 's551_template.dxf')); a = d2.audit(); print('layers', len(d2.layers), 'blocks', len(d2.blocks), 'errors', len(a.errors), 'fixes', len(a.fixes))
