# -*- coding: utf-8 -*-
"""Builds a small synthetic Dragon Age savegame zip (XDroid360 layout) for testing the bridge."""
import io, struct, sys, zipfile, zlib, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'src', 'main', 'python'))
import gff4
from gff4 import *
from gff4 import _structtype, _listtype
from gff4.datoolset_fields import *

def F(label, type_, indirect=False):
    return Field(label, type_, indirect, 0)

def _fsize(t):
    if t in DATATYPES:
        return t.size, (16 if t.size >= 16 else 8 if t.size == 8 else 4)
    if issubclass(t, List):
        return 4, 4
    return t.size, 4

def S(fourcc, fields):
    off, out, align = 0, [], 4
    for f in fields:
        sz, al = _fsize(f.type)
        off = (off + al - 1) // al * al
        out.append(Field(f.label, f.type, f.indirect, off))
        off += sz
        align = max(align, al)
    size = (off + align - 1) // align * align
    return _structtype(fourcc, tuple(out), size)

POS = Vector4f
ITEM = S('ITEM', [F(TEMPLATERESREF, ECString), F(OBJECT_ID, UINT32), F(POSITION, POS), F(ITEM_STACKSIZE, INT32),
                  F(SAVEGAME_ITEM_INFINITE, UINT8), F(SAVEGAME_OBJECT_PLOT, UINT8)])
ITEMS = _listtype(ITEM)
PLC = S('PLC1', [F(TEMPLATERESREF, ECString), F(SAVEGAME_ITEMS, ITEMS)])
CRE = S('CRE1', [F(TEMPLATERESREF, ECString), F(SAVEGAME_BACKPACK, ITEMS), F(SAVEGAME_PLOTITEMS, ITEMS),
                 F(SAVEGAME_EQUIPMENT_ITEMS, ITEMS)])
STORE = S('STO1', [F(TEMPLATERESREF, ECString), F(SAVEGAME_STORE_ITEMLIST, ITEMS)])
AREA = S('AREA', [F(TAG, ECString), F(SAVEGAME_AREA_PLACEABLES, _listtype(PLC)), F(SAVEGAME_AREA_CREATURES, _listtype(CRE)),
                  F(SAVEGAME_AREA_STORES, _listtype(STORE))])
AREAROOT = S('ARRT', [F(16023, AREA)])
AREC = S('AREC', [F(TAG, ECString), F(16021, _listtype(UINT8)), F(16022, UINT32)])

STAT = S('ATTR', [F(SAVEGAME_STATPROPERTY_INDEX, UINT32), F(SAVEGAME_STATPROPERTY_BASE, FLOAT32),
                  F(SAVEGAME_STATPROPERTY_MODIFIER, FLOAT32), F(SAVEGAME_STATPROPERTY_CURRENT, FLOAT32)])
SMPL = S('SMPL', [F(SAVEGAME_STATPROPERTY_INDEX, UINT32), F(SAVEGAME_STATPROPERTY_BASE, FLOAT32)])
QS = S('QSLT', [F(SAVEGAME_QUICKSLOT_ABILITY, UINT32)])
CSTATS = S('CPS1', [F(SAVEGAME_STATLIST, _listtype(None, True)),
                    F(SAVEGAME_SPELLLIST, _listtype(UINT32)), F(SAVEGAME_TALENTLIST, _listtype(UINT32)),
                    F(SAVEGAME_SKILLLIST, _listtype(UINT32)), F(SAVEGAME_QUICKSLOTS, _listtype(QS))])
NAME = S('NAME', [F(1, UINT32), F(2, ECString)])
CREATURE = S('CRL1', [F(OBJECT_ID, UINT32), F(3, ECString), F(SAVEGAME_OBJECT_NAME, TlkString),
                      F(SAVEGAME_CREATURE_STATS, CSTATS)])
APR = S('APR1', [F(SAVEGAME_PARTY_APPROVAL_ID, UINT32), F(SAVEGAME_PARTY_APPROVAL_LEVEL, INT32)])
PARTYSTORE = S('PST1', [F(SAVEGAME_STORE_ITEMLIST, ITEMS)])
PARTY = S('PRTY', [F(SAVEGAME_MONEY, INT32), F(SAVEGAME_MAX_ITEMS, INT32), F(SAVEGAME_BACKPACK, ITEMS),
                   F(SAVEGAME_PLOTITEMS, ITEMS), F(SAVEGAME_PARTYPOOLMEMBERS, _listtype(CREATURE)),
                   F(SAVEGAME_PARTY_APPROVAL_LIST, _listtype(APR)), F(32000, PARTYSTORE)])
PLAYER = S('PLYR', [F(SAVEGAME_PLAYERCHAR_CHAR, CREATURE), F(SAVEGAME_PLAYER_TIME_PLAYED, FLOAT32)])
WDB = S('WDB1', [F(SAVEGAME_WORLDDB_IDGROUP, UINT32), F(SAVEGAME_WORLDDB_LASTID, UINT32)])
ROOT = S('ROOT', [F(SAVEGAME_PARTYLIST, PARTY), F(SAVEGAME_PLAYERCHAR, PLAYER), F(SAVEGAME_WORLDDATABASE, _listtype(WDB)),
                  F(SAVEGAME_AREALIST, _listtype(None, True))])

def item(resref, n, oid):
    it = ITEM(); it[TEMPLATERESREF] = resref + '\0'; it[OBJECT_ID] = oid; it[ITEM_STACKSIZE] = n
    it[POSITION] = Vector4f(float(oid), 0, 0, 0); return it

def creature(oid, resref, name):
    c = CREATURE(); c[OBJECT_ID] = oid; c[3] = resref + '\0'; c[SAVEGAME_OBJECT_NAME] = TlkString(0, name + '\0')
    st = c[SAVEGAME_CREATURE_STATS]
    for idx, base in ((1, 20.0), (15, 7.0), (19, 12345.0), (34, 2.0)):
        e = ATTR_new(idx, base); st[SAVEGAME_STATLIST].append(e)
    sm = SMPL(); sm[SAVEGAME_STATPROPERTY_INDEX] = 36; sm[SAVEGAME_STATPROPERTY_BASE] = 3.0   # real saves have SMPL entries
    st[SAVEGAME_STATLIST].append(sm)
    st[SAVEGAME_SPELLLIST].append(UINT32(100601))
    return c

def ATTR_new(idx, base):
    e = STAT(); e[SAVEGAME_STATPROPERTY_INDEX] = idx; e[SAVEGAME_STATPROPERTY_BASE] = base; return e

def build_gff_bytes(root):
    header = build_header(root, 'PC  ', 'SAVG', 'V1.0')
    buf = io.BytesIO(); write_gff4(buf, root, header); return buf.getvalue()

def make_root():
    root = ROOT()
    p = root[SAVEGAME_PARTYLIST]
    p[SAVEGAME_MONEY] = 1234; p[SAVEGAME_MAX_ITEMS] = 70
    p[SAVEGAME_BACKPACK].append(item('gen_im_wep_swd_lsw_01', 1, 1001))
    p[SAVEGAME_BACKPACK].append(item('gen_im_cns_pot_hlt_01', 5, 1002))
    p[SAVEGAME_PLOTITEMS].append(item('plt_quest_item', 1, 1003))
    p[32000][SAVEGAME_STORE_ITEMLIST].append(item('gen_im_cns_pot_man_01', 3, 1004))
    p[SAVEGAME_PARTYPOOLMEMBERS].append(creature(2001, 'alistair', 'Alistair'))
    a = APR(); a[SAVEGAME_PARTY_APPROVAL_ID] = 2001; a[SAVEGAME_PARTY_APPROVAL_LEVEL] = 10
    p[SAVEGAME_PARTY_APPROVAL_LIST].append(a)
    pl = root[SAVEGAME_PLAYERCHAR]
    pl[SAVEGAME_PLAYERCHAR_CHAR] = creature(1, 'player', 'Tester'); pl[SAVEGAME_PLAYER_TIME_PLAYED] = 3725.0
    w = WDB(); w[SAVEGAME_WORLDDB_IDGROUP] = 0; w[SAVEGAME_WORLDDB_LASTID] = 5000
    root[SAVEGAME_WORLDDATABASE].append(w)
    # plain area with a chest
    ar = AREA(); ar[TAG] = 'plain_area\0'
    pc = PLC(); pc[TEMPLATERESREF] = 'chest_a\0'; pc[SAVEGAME_ITEMS].append(item('gen_im_misc_gem_01', 2, 3001))
    ar[SAVEGAME_AREA_PLACEABLES].append(pc)
    root[SAVEGAME_AREALIST].append(ar)
    # compressed area (AREC)
    inner = AREAROOT(); ia = inner[16023]; ia[TAG] = 'packed_area\0'
    pc2 = PLC(); pc2[TEMPLATERESREF] = 'chest_b\0'; pc2[SAVEGAME_ITEMS].append(item('gen_im_misc_gem_02', 4, 3002))
    ia[SAVEGAME_AREA_PLACEABLES].append(pc2)
    raw = build_gff_bytes(inner)
    arec = AREC(); arec[TAG] = 'packed_area\0'; arec[16022] = len(raw); arec[16021] = Binary(zlib.compress(raw))
    root[SAVEGAME_AREALIST].append(arec)
    return root

def make_zip(path):
    data = build_gff_bytes(make_root())
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        base = 'content/454108C0/00000001/AABBCC/Saves/'
        z.writestr(base + 'savegame.das', data)
        z.writestr(base + 'savegame.das.x', struct.pack('>I', zlib.crc32(data) & 0xFFFFFFFF))
        z.writestr('content/454108C0/00000001/AABBCC.name',
                   ('Tester Test_20260101120000\0').encode('utf-16-be').ljust(256, b'\0'))
    return path

if __name__ == '__main__':
    print(make_zip(sys.argv[1] if len(sys.argv) > 1 else 'test_save.zip'))
