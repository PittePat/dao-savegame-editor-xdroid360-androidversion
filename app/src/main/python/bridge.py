# -*- coding: utf-8 -*-
"""JSON bridge between the Android UI (WebView) and the savegame logic.

The editor logic (gff4/, abilities.py, savezip.py) is the unchanged core of the desktop editor.
This module replaces the wxPython GUI: every UI action is one function here that takes plain
values and returns plain data. The UI calls `call(method, json_args)` and gets a JSON string back.
"""
import json
import os
import pkgutil
import re
import traceback
import zlib
from io import BytesIO

from gff4 import *                      # noqa: F401,F403  (INT32, Binary, ...)
from gff4.lazy import LazyGFF4
from gff4.datoolset_fields import *     # noqa: F401,F403  (SAVEGAME_* field ids)
from savezip import find_saves, read_member, replace_in_zip, format_seconds
from abilities import (AbilityModel, POINT_STATS, KIND_TITLE, stat_value, set_point_stat,
                       add_stat_property)

MAX_MONEY = 999999999

LANG = 'de'


def set_lang(lang):
    """UI language for error messages ('de' or anything else = English)."""
    global LANG
    LANG = 'de' if lang == 'de' else 'en'
    return LANG


def T(de, en):
    return de if LANG == 'de' else en


def _read_lines(name):
    # pkgutil also works when the package is loaded from inside the APK (Chaquopy), where open() would not
    data = pkgutil.get_data('gff4', name)
    return [line.strip() for line in data.decode('utf-8').splitlines()]


_attribute_names = [line.split(',') for line in _read_lines('StatPropertyNames.txt')]
_resrefnames = dict(line.split(None, 1) for line in _read_lines('ResRefNames.txt') if line)
_RESREF_RE = re.compile(r'^[A-Za-z0-9_]+$')

# --------------------------------------------------------------------------- helpers


def _fit_string(old, new):
    """Strings of V4.0 (PC) files carry a trailing NUL; keep whatever convention the old value used."""
    new = new.strip().strip('\0')
    return new + '\0' if old.endswith('\0') else new


def _coerce_like(old, value):
    """Converts a value coming from the UI to the type of the value it replaces."""
    if isinstance(old, str):
        return type(old)(_fit_string(old, str(value)))
    if isinstance(old, bool):
        if isinstance(value, str):
            return value.strip().lower() in ('1', 'true', 'yes', 'on')
        return bool(value)
    if isinstance(old, int):
        return type(old)(int(float(str(value).strip())))
    if isinstance(old, float):
        return type(old)(float(str(value).strip().replace(',', '.')))
    return type(old)(value)


def describe_fields(row):
    """Every field of a structure as (label, name, typename, text, editable)."""
    out = []
    for field in row.fields:
        label = field.label
        try:
            value = row[label]
        except Exception:
            continue
        name = str(get_field_name(label))
        editable = False
        if isinstance(value, bytes):
            text = 'Binary (%d bytes)' % len(value)
        elif isinstance(value, str):
            text, editable = value.strip('\0'), True
        elif isinstance(value, (int, float)):
            text, editable = str(value), True
        elif isinstance(value, tuple):
            text = repr(value)
        elif hasattr(value, 'fields'):
            text = 'Struct %s' % getattr(value, 'fourcc', '?')
        elif hasattr(value, '__len__'):
            text = 'List (%d entries)' % len(value)
        else:
            text = repr(value)
        out.append((label, name, type(value).__name__.replace('Lazy', ''), text, editable))
    return out


def apply_field_texts(row, texts):
    """Writes {label: text} into a structure. Returns (changed_labels, [(label, text, error)])."""
    changed, errors = [], []
    for label, text in texts.items():
        old = row[label]
        try:
            if isinstance(old, str):
                new = type(old)(_fit_string(old, text))
            else:
                new = type(old)(text.strip())
        except (ValueError, TypeError, OverflowError) as ex:
            errors.append((label, text, str(ex)))
            continue
        if new != old:
            row[label] = new
            changed.append(label)
    return changed, errors


def filter_known_items(names, text, limit=300):
    words = text.lower().split()
    result = []
    for resref in sorted(names):
        hay = (resref + ' ' + names[resref]).lower()
        if all(w in hay for w in words):
            result.append((resref, names[resref]))
            if len(result) >= limit:
                break
    return result


def _clean(s):
    return str(s).strip('\0')


# --------------------------------------------------------------------------- session state


class Session(object):
    def __init__(self):
        self.reset()

    def reset(self):
        self.path = None
        self.member = None
        self.gff = None
        self.root = None
        self.wdbe = None
        self.characters = []      # [{'name', 'creature', 'stats'}]
        self.areas = {}           # area index -> {'area', 'gff', 'body', 'dirty'}
        self.chests = {}          # key -> (name, list)
        self.dirty = False


S = Session()

AREA_TYPES = [
    ('placeables', 'Placeables'),
    ('stores', 'Stores'),
    ('equip', "Creature's Equipment"),
    ('backpack', "Creature's Backpack"),
    ('plot', "Creature's Plot Items"),
]


# --------------------------------------------------------------------------- opening


def list_saves(zip_path):
    out = []
    for s in find_saves(zip_path):
        out.append({
            'member': s.member,
            'title': s.title or s.folder,
            'character': s.character,
            'area': s.area,
            'played': format_seconds(s.played),
            'level': s.level,
            'saved': s.saved.strftime('%Y-%m-%d %H:%M') if s.saved else '',
        })
    return out


def open_save(zip_path, member):
    S.reset()
    gff = LazyGFF4(BytesIO(read_member(zip_path, member)))
    if gff.header.version != 'V4.0':
        raise ValueError(T('Nur Dragon Age: Origins Spielstände werden unterstützt (GFF %s)',
                           'Only Dragon Age: Origins savegames are supported (GFF %s)') % gff.header.version)
    root = gff.root
    S.path, S.member, S.gff, S.root = zip_path, member, gff, root
    S.wdbe = next(x for x in root[SAVEGAME_WORLDDATABASE] if x[SAVEGAME_WORLDDB_IDGROUP] == 0)

    party = root[SAVEGAME_PARTYLIST]
    crp1 = root[SAVEGAME_PLAYERCHAR][SAVEGAME_PLAYERCHAR_CHAR]
    ids2name = {}
    for crl1 in (party[SAVEGAME_PARTYPOOLMEMBERS] or ()):
        name = crl1[SAVEGAME_OBJECT_NAME].s
        if not name:
            resref = crl1[3].strip('\0')
            name = _resrefnames.get(resref, resref)
        ids2name[crl1[OBJECT_ID]] = _clean(name)
    S.ids2name = ids2name

    S.characters = [{'name': _clean(crp1[SAVEGAME_OBJECT_NAME].s), 'creature': crp1}]
    for crl1 in (party[SAVEGAME_PARTYPOOLMEMBERS] or ()):
        S.characters.append({'name': ids2name[crl1[OBJECT_ID]], 'creature': crl1})
    for c in S.characters:
        c['stats'] = c['creature'][SAVEGAME_CREATURE_STATS][SAVEGAME_STATLIST]

    # extra chests (Warden's Keep / Awakening)
    for area in root[SAVEGAME_AREALIST]:
        if area[TAG] == 'gwb201ar_sp_repaired\0':
            placename, suffix, key = 'gwb201ip_party_chest\0', " (Warden's Keep)", 'chest:keep'
        elif area[TAG] == 'vgk210ar_throne_room\0':
            placename, suffix, key = 'vgk210ip_party_chest\0', ' (Awakening)', 'chest:awakening'
        else:
            continue
        for placeable in area[SAVEGAME_AREA_PLACEABLES]:
            if placeable[TEMPLATERESREF] == placename:
                label = _resrefnames.get(placename.strip('\0'), 'Party chest') + suffix
                S.chests[key] = (label, placeable[SAVEGAME_ITEMS])
                break
    return overview()


def overview():
    root, party = S.root, S.root[SAVEGAME_PARTYLIST]
    try:
        played = int(float(root[SAVEGAME_PLAYERCHAR][SAVEGAME_PLAYER_TIME_PLAYED]))
    except (KeyError, TypeError, ValueError):
        played = None
    invs = [{'key': 'backpack', 'name': 'Backpack', 'count': len(party[SAVEGAME_BACKPACK])},
            {'key': 'plot', 'name': 'Plot items', 'count': len(party[SAVEGAME_PLOTITEMS])}]
    if 32000 in party:
        invs.append({'key': 'party', 'name': 'Party storage',
                     'count': len(party[32000][SAVEGAME_STORE_ITEMLIST])})
    for key, (label, lst) in S.chests.items():
        invs.append({'key': key, 'name': label, 'count': len(lst)})
    approvals = []
    for aprv in (party[SAVEGAME_PARTY_APPROVAL_LIST] or ()):
        pid = aprv[SAVEGAME_PARTY_APPROVAL_ID]
        approvals.append({'id': int(pid), 'name': S.ids2name.get(pid, T('Unbekannt %d', 'Unknown %d') % pid),
                          'level': int(aprv[SAVEGAME_PARTY_APPROVAL_LEVEL])})
    return {
        'money': int(party[SAVEGAME_MONEY]),
        'capacity': int(party[SAVEGAME_MAX_ITEMS]),
        'played': format_seconds(played),
        'characters': [{'idx': i, 'name': c['name']} for i, c in enumerate(S.characters)],
        'inventories': invs,
        'approvals': approvals,
        'areas': [{'idx': i, 'tag': _clean(a[TAG]), 'name': _resrefnames.get(_clean(a[TAG]), '')}
                  for i, a in enumerate(root[SAVEGAME_AREALIST])],
        'area_types': [{'key': k, 'name': n} for k, n in AREA_TYPES],
        'unknown_stat_count': len(_attribute_names),
    }


# --------------------------------------------------------------------------- general values


def set_general(money=None, capacity=None):
    party = S.root[SAVEGAME_PARTYLIST]
    if money is not None:
        v = max(0, min(MAX_MONEY, int(money)))
        if party[SAVEGAME_MONEY] != v:
            party[SAVEGAME_MONEY] = INT32(v)
            S.dirty = True
    if capacity is not None:
        v = max(0, min(MAX_MONEY, int(capacity)))
        if party[SAVEGAME_MAX_ITEMS] != v:
            party[SAVEGAME_MAX_ITEMS] = INT32(v)
            S.dirty = True
    return {'money': int(party[SAVEGAME_MONEY]), 'capacity': int(party[SAVEGAME_MAX_ITEMS])}


def set_approval(pid, level):
    level = max(-100, min(100, int(level)))
    for aprv in S.root[SAVEGAME_PARTYLIST][SAVEGAME_PARTY_APPROVAL_LIST]:
        if aprv[SAVEGAME_PARTY_APPROVAL_ID] == pid:
            if aprv[SAVEGAME_PARTY_APPROVAL_LEVEL] != level:
                aprv[SAVEGAME_PARTY_APPROVAL_LEVEL] = INT32(level)
                S.dirty = True
            return level
    raise KeyError(T('Unbekannte Begleiter-ID %s', 'Unknown companion ID %s') % pid)


# --------------------------------------------------------------------------- inventories / items


def _area(ai):
    ai = int(ai)
    if ai not in S.areas:
        area = S.root[SAVEGAME_AREALIST][ai]
        if area.fourcc == 'AREC':
            g = LazyGFF4(BytesIO(zlib.decompress(area[16021])))
            S.areas[ai] = {'area': area, 'gff': g, 'body': g.root[16023], 'dirty': False}
        else:
            S.areas[ai] = {'area': area, 'gff': None, 'body': area, 'dirty': False}
    return S.areas[ai]


def _area_lists(ai, kind):
    body = _area(ai)['body']
    out = []
    if kind == 'stores':
        out = [(c[TEMPLATERESREF], c[SAVEGAME_STORE_ITEMLIST]) for c in body[SAVEGAME_AREA_STORES]]
    elif kind == 'placeables':
        out = [(c[TEMPLATERESREF], c[SAVEGAME_ITEMS]) for c in body[SAVEGAME_AREA_PLACEABLES]]
    elif kind == 'equip':
        out = [(c[TEMPLATERESREF], c[SAVEGAME_EQUIPMENT_ITEMS]) for c in body[SAVEGAME_AREA_CREATURES]]
    elif kind == 'backpack':
        out = [(c[TEMPLATERESREF], c[SAVEGAME_BACKPACK]) for c in body[SAVEGAME_AREA_CREATURES]]
    elif kind == 'plot':
        out = [(c[TEMPLATERESREF], c[SAVEGAME_PLOTITEMS]) for c in body[SAVEGAME_AREA_CREATURES]]
    else:
        raise KeyError(T('Unbekannter Typ %s', 'Unknown type %s') % kind)
    return out


def _inv(key):
    """Item list (the savegame structure) for an inventory key."""
    party = S.root[SAVEGAME_PARTYLIST]
    if key == 'backpack':
        return party[SAVEGAME_BACKPACK]
    if key == 'plot':
        return party[SAVEGAME_PLOTITEMS]
    if key == 'party':
        return party[32000][SAVEGAME_STORE_ITEMLIST]
    if key in S.chests:
        return S.chests[key][1]
    if key.startswith('area:'):
        _, ai, kind, ci = key.split(':')
        return _area_lists(ai, kind)[int(ci)][1]
    raise KeyError(T('Unbekanntes Inventar %s', 'Unknown inventory %s') % key)


def _touch(key):
    S.dirty = True
    if key.startswith('area:'):
        _area(key.split(':')[1])['dirty'] = True


def _item_row(i, row):
    resref = _clean(row[TEMPLATERESREF])
    return {
        'i': i,
        'resref': resref,
        'name': _resrefnames.get(resref, ''),
        'count': int(row[ITEM_STACKSIZE]),
        'infinite': int(row[SAVEGAME_ITEM_INFINITE]),
        'plot': int(row[SAVEGAME_OBJECT_PLOT]),
    }


def items(key, query='', offset=0, limit=60):
    lst = _inv(key)
    words = query.lower().split()
    rows = []
    for i, row in enumerate(lst):
        r = _item_row(i, row)
        if words:
            hay = (r['resref'] + ' ' + r['name']).lower()
            if not all(w in hay for w in words):
                continue
        rows.append(r)
    total = len(rows)
    return {'total': total, 'rows': rows[offset:offset + limit], 'size': len(lst)}


def item_set(key, i, field, value):
    row = _inv(key)[int(i)]
    if field == 'resref':
        text = str(value).strip().strip('\0')
        if not _RESREF_RE.match(text):
            raise ValueError(T('Ungültige ResRef: nur Buchstaben, Ziffern und _ erlaubt', 'Invalid ResRef: only letters, digits and _ allowed'))
        old = row[TEMPLATERESREF]
        row[TEMPLATERESREF] = type(old)(_fit_string(old, text))
    elif field == 'count':
        row[ITEM_STACKSIZE] = _coerce_like(row[ITEM_STACKSIZE], max(0, int(float(str(value)))))
    elif field == 'infinite':
        row[SAVEGAME_ITEM_INFINITE] = _coerce_like(row[SAVEGAME_ITEM_INFINITE], value)
    else:
        raise KeyError('Feld %s' % field)
    _touch(key)
    return _item_row(int(i), row)


def _append_item(lst, item):
    if len(lst):
        item[POSITION] = item[POSITION]._replace(a=lst[len(lst) - 1][POSITION].a + 1)
    else:
        item[POSITION] = item[POSITION]._replace(a=0.)
    lst.append(item)


def item_duplicate(key, i):
    lst = _inv(key)
    row = lst[int(i)]
    cop = type(row)(row)
    S.wdbe[SAVEGAME_WORLDDB_LASTID] += 1
    cop[OBJECT_ID] = S.wdbe[SAVEGAME_WORLDDB_LASTID]
    _append_item(lst, cop)
    _touch(key)
    return len(lst) - 1


def item_move(key, i, dest):
    if dest == key:
        raise ValueError(T('Quelle und Ziel sind gleich', 'Source and destination are the same'))
    src, dst = _inv(key), _inv(dest)
    row = src[int(i)]
    del src[int(i)]
    _append_item(dst, row)
    _touch(key)
    _touch(dest)
    return True


def item_delete(key, i):
    lst = _inv(key)
    del lst[int(i)]
    _touch(key)
    return True


def item_fields(key, i):
    row = _inv(key)[int(i)]
    return [{'label': int(l), 'name': n, 'type': t, 'text': x, 'editable': e}
            for (l, n, t, x, e) in describe_fields(row)]


def item_apply_fields(key, i, texts):
    row = _inv(key)[int(i)]
    changed, errors = apply_field_texts(row, {int(k): v for k, v in texts.items()})
    if changed:
        _touch(key)
    return {'changed': len(changed),
            'errors': ['%s = %r (%s)' % (get_field_name(l), t, e) for l, t, e in errors]}


def search_known_items(query):
    names = dict(_resrefnames)
    return [{'resref': r, 'name': n} for r, n in filter_known_items(names, query)]


# --------------------------------------------------------------------------- areas


def area_containers(ai, kind, show_empty=False):
    out = []
    for ci, (resref, lst) in enumerate(_area_lists(ai, kind)):
        n = len(lst)
        if show_empty or n:
            r = _clean(resref)
            out.append({'ci': ci, 'count': n, 'name': _resrefnames.get(r, r), 'resref': r,
                        'key': 'area:%d:%s:%d' % (int(ai), kind, ci)})
    return out


# --------------------------------------------------------------------------- characters: stats


def _char(ci):
    return S.characters[int(ci)]


_COLS = [('base', SAVEGAME_STATPROPERTY_BASE), ('mod', SAVEGAME_STATPROPERTY_MODIFIER),
         ('cur', SAVEGAME_STATPROPERTY_CURRENT), ('regen', SAVEGAME_STATPROPERTY_REGEN),
         ('comregen', SAVEGAME_STATPROPERTY_COMREGEN)]


def _prop_name(pid):
    if 0 < pid <= len(_attribute_names):
        name = _attribute_names[pid - 1][0]
        if name:
            return name
    return 'Property %d' % pid


def stats(ci):
    out = []
    for i, entry in enumerate(_char(ci)['stats']):
        pid = int(entry[SAVEGAME_STATPROPERTY_INDEX])
        row = {'i': i, 'id': pid, 'name': _prop_name(pid)}
        for col, label in _COLS:
            row[col] = float(entry[label]) if label in entry else None
        out.append(row)
    addable = []
    existing = set(r['id'] for r in out)
    for idx, attr in enumerate(_attribute_names):
        if (idx + 1) not in existing:
            addable.append({'id': idx + 1, 'name': attr[0]})
    return {'rows': out, 'addable': sorted(addable, key=lambda a: a['name'])}


def stat_set(ci, i, col, value):
    entry = _char(ci)['stats'][int(i)]
    label = dict(_COLS)[col]
    if label not in entry:
        raise KeyError(T('Dieser Wert existiert für die Eigenschaft nicht', 'This value does not exist for the property'))
    entry[label] = _coerce_like(entry[label], value)
    S.dirty = True
    return float(entry[label])


def stat_add(ci, index):
    index = int(index)
    c = _char(ci)
    if any(int(a[SAVEGAME_STATPROPERTY_INDEX]) == index for a in c['stats']):
        raise ValueError(T('Diese Eigenschaft hat der Charakter schon', 'The character already has this property'))
    fourcc = _attribute_names[index - 1][1] if index <= len(_attribute_names) else 'ATTR'
    add_stat_property(S.root, c['stats'], index, fourcc)
    S.dirty = True
    return True


# --------------------------------------------------------------------------- characters: points / abilities


def points(ci):
    st = _char(ci)['stats']
    return {
        'points': [{'index': idx, 'label': label, 'hint': hint, 'value': int(stat_value(st, idx))}
                   for idx, label, hint in POINT_STATS],
        'level': int(stat_value(st, 15)),
        'xp': int(stat_value(st, 19)),
    }


def points_set(ci, index, value):
    value = max(0, min(9999, int(value)))
    if set_point_stat(S.root, _char(ci)['stats'], int(index), value):
        S.dirty = True
    return value


def abilities(ci):
    model = AbilityModel(_char(ci)['creature'][SAVEGAME_CREATURE_STATS])
    return [{'kind': r.kind, 'kind_title': KIND_TITLE[r.kind], 'id': r.id, 'name': r.name,
             'group': r.group, 'learned': bool(r.learned), 'known': bool(r.known)}
            for r in model.rows()]


def ability_set(ci, kind, ability_id, learned):
    model = AbilityModel(_char(ci)['creature'][SAVEGAME_CREATURE_STATS])
    if model.set_learned(kind, int(ability_id), bool(learned)):
        S.dirty = True
    return model.is_learned(kind, ability_id)


# --------------------------------------------------------------------------- saving


def save():
    """Writes all changes into the zip (which also refreshes the '.x' CRC32). Returns the CRC as hex."""
    if S.root is None:
        raise RuntimeError(T('Kein Spielstand geöffnet', 'No savegame open'))
    for entry in S.areas.values():
        if entry['dirty'] and entry['gff'] is not None:
            buf = BytesIO()
            entry['gff'].tofile(buf)
            data = buf.getvalue()
            entry['area'][16022] = len(data)
            entry['area'][16021] = Binary(zlib.compress(data))
            entry['dirty'] = False
    buf = BytesIO()
    S.gff.tofile(buf)
    crc = replace_in_zip(S.path, S.member, buf.getvalue())
    S.dirty = False
    return '%08X' % crc


# --------------------------------------------------------------------------- dispatcher

_API = {
    'list_saves': list_saves, 'open_save': open_save, 'overview': overview,
    'set_general': set_general, 'set_approval': set_approval,
    'items': items, 'item_set': item_set, 'item_duplicate': item_duplicate, 'item_move': item_move,
    'item_delete': item_delete, 'item_fields': item_fields, 'item_apply_fields': item_apply_fields,
    'search_known_items': search_known_items, 'area_containers': area_containers,
    'stats': stats, 'stat_set': stat_set, 'stat_add': stat_add,
    'points': points, 'points_set': points_set,
    'abilities': abilities, 'ability_set': ability_set,
    'save': save, 'set_lang': set_lang,
    'is_dirty': lambda: S.dirty,
}


def call(method, args_json='{}'):
    """Entry point for the UI. Always returns a JSON string: {"ok": true, "data": ...} or {"ok": false, "error": ...}."""
    try:
        fn = _API[method]
        args = json.loads(args_json) if args_json else {}
        return json.dumps({'ok': True, 'data': fn(**args)})
    except Exception as ex:      # noqa: BLE001 - everything must reach the UI as text
        traceback.print_exc()
        return json.dumps({'ok': False, 'error': '%s: %s' % (type(ex).__name__, ex)})
