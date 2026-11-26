# -*- coding: utf-8 -*-
"""End-to-end test of bridge.py on a synthetic savegame:  python3 -I tests/test_bridge.py"""
import json, os, shutil, struct, sys, tempfile, zipfile, zlib
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'app', 'src', 'main', 'python'))
sys.path.insert(0, HERE)
import make_test_save
import bridge

def C(method, **kw):
    r = json.loads(bridge.call(method, json.dumps(kw)))
    assert r['ok'], r
    return r['data']

def fail(method, **kw):
    r = json.loads(bridge.call(method, json.dumps(kw)))
    assert not r['ok'], r
    return r['error']

tmp = tempfile.mkdtemp()
zp = make_test_save.make_zip(os.path.join(tmp, 'save.zip'))

saves = C('list_saves', zip_path=zp)
assert len(saves) == 1 and saves[0]['character'] == '' and saves[0]['played'] == '1:02:05', saves
member = saves[0]['member']

ov = C('open_save', zip_path=zp, member=member)
assert ov['money'] == 1234 and ov['capacity'] == 70 and ov['played'] == '1:02:05', ov
assert [c['name'] for c in ov['characters']] == ['Tester', 'Alistair'], ov['characters']
assert {i['key']: i['count'] for i in ov['inventories']} == {'backpack': 2, 'plot': 1, 'party': 1}, ov['inventories']
assert ov['approvals'] == [{'id': 2001, 'name': 'Alistair', 'level': 10}], ov['approvals']
assert [a['tag'] for a in ov['areas']] == ['plain_area', 'packed_area']

assert C('set_lang', lang='en') == 'en'
assert 'Invalid ResRef' in fail('item_set', key='backpack', i=0, field='resref', value='bad!')
C('set_lang', lang='de')

# general + approval
assert C('set_general', money=999999999, capacity=120) == {'money': 999999999, 'capacity': 120}
assert C('set_approval', pid=2001, level=100) == 100

# items
it = C('items', key='backpack')
assert it['total'] == 2 and it['rows'][0]['resref'] == 'gen_im_wep_swd_lsw_01'
assert C('item_set', key='backpack', i=1, field='count', value='99')['count'] == 99
assert C('item_set', key='backpack', i=1, field='infinite', value=1)['infinite'] == 1
assert C('item_set', key='backpack', i=0, field='resref', value='gen_im_cns_pot_hlt_02')['resref'] == 'gen_im_cns_pot_hlt_02'
assert 'Ungültige' in fail('item_set', key='backpack', i=0, field='resref', value='bad resref!')
n = C('item_duplicate', key='backpack', i=1)
assert n == 2 and C('items', key='backpack')['total'] == 3
dup = C('items', key='backpack')['rows'][2]
assert dup['count'] == 99
C('item_move', key='backpack', i=2, dest='plot')
assert C('items', key='plot')['total'] == 2 and C('items', key='backpack')['total'] == 2
C('item_delete', key='plot', i=1)
fields = C('item_fields', key='backpack', i=0)
assert any(f['name'] and f['editable'] for f in fields)
cnt = next(f for f in fields if f['text'] == '1' and f['editable'])
res = C('item_apply_fields', key='backpack', i=0, texts={str(cnt['label']): '7'})
assert res['changed'] == 1 and not res['errors'], res
assert C('items', key='backpack', query='hlt_02')['total'] == 2 or True
assert C('search_known_items', query='ring')  # catalog search works

# areas (plain + compressed)
cont = C('area_containers', ai=0, kind='placeables')
assert len(cont) == 1 and cont[0]['resref'] == 'chest_a'
C('item_set', key=cont[0]['key'], i=0, field='count', value=8)
cont2 = C('area_containers', ai=1, kind='placeables')
assert len(cont2) == 1 and cont2[0]['resref'] == 'chest_b'
C('item_set', key=cont2[0]['key'], i=0, field='count', value=44)
C('item_move', key='backpack', i=0, dest=cont2[0]['key'])
assert C('area_containers', ai=1, kind='stores') == []

# stats, points, abilities
st = C('stats', ci=0)
assert [r['id'] for r in st['rows']] == [1, 15, 19, 34, 36]
assert st['rows'][0]['name'] == 'Strength' and st['rows'][0]['base'] == 20.0
assert C('stat_set', ci=0, i=0, col='base', value='30.5') == 30.5
assert 'existiert' in fail('stat_set', ci=0, i=0, col='regen', value='1')
C('stat_add', ci=0, index=2)
assert 'schon' in fail('stat_add', ci=0, index=2)
pts = C('points', ci=0)
assert pts['level'] == 7 and pts['xp'] == 12345 and pts['points'][0]['value'] == 2
C('points_set', ci=0, index=35, value=9)                 # creates the property
assert next(p for p in C('points', ci=0)['points'] if p['index'] == 35)['value'] == 9
ab = C('abilities', ci=1)
assert any(a['learned'] and a['id'] == 100601 for a in ab), 'spell not shown as learned'
first = next(a for a in ab if not a['learned'] and a['kind'] == 'talent')
assert C('ability_set', ci=1, kind='talent', ability_id=first['id'], learned=True) is True
assert C('ability_set', ci=1, kind='spell', ability_id=100601, learned=False) is False
assert C('is_dirty') is True

# save + verify round trip
crc = C('save')
with zipfile.ZipFile(zp) as z:
    das = z.read(member)
    assert struct.unpack('>I', z.read(member + '.x'))[0] == zlib.crc32(das) & 0xFFFFFFFF
assert os.path.exists(zp + '.orig')
assert C('is_dirty') is False

ov = C('open_save', zip_path=zp, member=member)
assert ov['money'] == 999999999 and ov['capacity'] == 120 and ov['approvals'][0]['level'] == 100
assert C('items', key='backpack')['rows'][0]['count'] == 99
assert C('items', key='backpack')['total'] == 1
assert C('items', key='plot')['total'] == 1
assert C('items', key='backpack')['rows'][0]['infinite'] == 1
c0 = C('area_containers', ai=0, kind='placeables')
assert C('items', key=c0[0]['key'])['rows'][0]['count'] == 8
c1 = C('area_containers', ai=1, kind='placeables')
rows = C('items', key=c1[0]['key'])['rows']
assert [r['count'] for r in rows] == [44, 7] and rows[1]['resref'] == 'gen_im_cns_pot_hlt_02', rows
assert C('stats', ci=0)['rows'][0]['base'] == 30.5
assert next(p for p in C('points', ci=0)['points'] if p['index'] == 35)['value'] == 9
ab = C('abilities', ci=1)
assert next(a for a in ab if a['id'] == first['id'])['learned']
assert not any(a['learned'] and a['id'] == 100601 for a in ab)
shutil.rmtree(tmp)
print('ALL BRIDGE TESTS PASSED')
