"""把 mapsforge 的 render theme XML 翻譯成 MapLibre style JSON。

這是整個向量化專案風險最高的一塊，但可行的理由是兩種格式的規則結構相近：

    <rule e="way" k="highway" v="path"><line stroke="#8B4513" stroke-width="0.6"/></rule>
    {"type":"line","filter":["==","highway","path"],"paint":{"line-color":"#8B4513",...}}

產出是**起點不是終點**，之後要人工調校。

三個容易翻錯的語意（都對著 MOI_OSM.xml 實際統計過）：

  - `v="*"`（706 條）= key 存在，不是萬用字元字面值
  - `v="~"`（69 條）= key **不存在**；`v="~|no"` = 不存在或等於 no
  - 顏色同時有 `#RRGGBB` 與 **`#AARRGGBB`**（alpha 在**前**）。把 8 位當成
    RRGGBBAA 會讓所有半透明的描邊變成全透明，而那正是道路外框與陰影用的。

規則樹深達 8 層，子規則的條件與父規則是 AND 關係，zoom-min/max 也向下繼承
（取交集）。
"""

from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from build_sprite import DEFAULT_SIZE, sprite_name

NS = "{http://mapsforge.org/renderTheme}"

# 這三個值直接取自 raster 管線實際餵給 MapsforgeSrv 的設定
# （build/rudymap/config/tasks/rudy.properties），不是憑感覺調的：
#     line-scale=1.15  text-scale=1.25  symbol-scale=1.15  device/user-scale=1
#
# 為什麼不用再乘 2：MapLibre 一張圖磚畫 512px、mapsforge 畫 256px，但同一塊地在
# MapLibre z14 與 raster z15 都佔 512 像素（實測 bounds 確認過），像素密度相同。
# 畫在線／面上的注記，碰撞框往外放這麼多像素（MapLibre 預設 2）。
#
# mapsforge 的 `<caption>` 套在 way 上是「每條 way 在中心點標一次」，而 .map 裡
# 同一條路線被切成很多段 —— 「八通關古道」在一個 z11 畫面上實測會標 13 次，
# 其中好幾組還是並排重複。MapLibre 沒有「同字串去重」的機制，只能靠碰撞。
#
# 15 是實測出來的：東段 7→1、西段 2→1、主線 4→1，而**點注記（山頭、標高）一個
# 都沒少**（38 → 38）—— 因為只套在 way 規則上。再往上加到 30 就會整條路線都沒有
# 名字了。接線（RudyMapDump 把端點相近的同 tag 線段串起來）能讓圖徵數少 23%，
# 但那條路線本身在資料裡就是 25 段互不相接的碎片，光靠接線解決不了。
#
# z12 以上改回預設值：放大之後同名重複本來就不會擠在一起，那時候使用者要的是
# 「我腳下這條叫什麼」。實測固定用 15 的話，z13 原本僅有的那一個標籤也會被擋掉。
WAY_TEXT_PADDING = ["step", ["zoom"], 15, 12, 2]

WIDTH_SCALE = 1.15   # line-scale
TEXT_SCALE = 1.25    # text-scale

# mapsforge 的線寬會隨 zoom 指數放大，這不是主題寫的、是算繪器加的。
# 反組譯 mapsforgesrv-fatjar 的 RenderContext.setScaleStrokeWidth：
#
#     int zoomDiff = Math.max(zoomLevel - 12, 0);
#     renderTheme.scaleStrokeWidth((float) Math.pow(1.5, zoomDiff), zoomLevel);
#
# 再乘上 baseStrokeWidth（主題沒寫，預設 1）與 DisplayModel.lineScale（1.15）。
# 所以 raster z15 的線是主題值的 1.5³ × 1.15 = 3.88 倍；不翻這一段，向量在高
# zoom 會細到看不出道路階層。MapLibre 的 exponential 內插可以精確重現：
#     base^(z-z0) 的成長率，端點設成 A 與 A·base^(z1-z0) 就完全吻合。
#
# 文字則不隨 zoom 變（scaleTextSize 只吃 textScale），所以字級單純乘 1.25。
STROKE_BASE = 1.5
STROKE_ZOOM_MAX = 20

# 主題的 zoom 是 256px 圖磚的慣例，MapLibre 用 512px，同一個比例尺差一級。
# 主題寫 zoom-min="14" 指的是 raster z14，對應 MapLibre 的 z13。
ZOOM_OFFSET = -1


def color(v: str | None) -> str | None:
    """`#AARRGGBB` / `#RRGGBB` → MapLibre 吃得下的 `rgba()` 或 `#RRGGBB`。"""
    if not v or not v.startswith("#"):
        return v
    h = v[1:]
    if len(h) == 8:
        a = int(h[0:2], 16) / 255.0
        r, g, b = int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16)
        return f"rgba({r},{g},{b},{a:.3f})"
    return v


def num(v: str | None, scale: float = 1.0, default: float | None = None) -> float | None:
    if v is None:
        return default
    try:
        return round(float(v) * scale, 4)
    except ValueError:
        return default


def enabled_categories(root: ET.Element, style: str | None,
                       force_overlays: list[str] | None) -> tuple[set[str], str] | None:
    """算出某個樣式變體實際啟用哪些 category。

    照 MapsforgeSrv 的 XmlRenderThemeMenuCallback（raster 圖磚就是它產的）：

        categories = layer(id).getCategories()
        for overlay in layer(id).getOverlays():
            if overlay.isEnabled(): categories |= overlay.getCategories()

    只展開一層，overlay 的啟用與否看被引用 <layer> 的 enabled 屬性。
    """
    menu = root.find(f"{NS}stylemenu")
    if menu is None:
        return None
    layers = {lay.get("id"): lay for lay in menu.findall(f"{NS}layer")}
    chosen = style or menu.get("defaultvalue")
    base = layers.get(chosen)
    if base is None:
        raise SystemExit(f"主題沒有樣式 {chosen!r}，可選：{', '.join(sorted(layers))}")

    cats = {c.get("id") for c in base.findall(f"{NS}cat")}
    for ov in base.findall(f"{NS}overlay"):
        oid = ov.get("id")
        lay = layers.get(oid)
        if lay is None:
            continue
        on = oid in force_overlays if force_overlays else lay.get("enabled") == "true"
        if on:
            cats |= {c.get("id") for c in lay.findall(f"{NS}cat")}
    return {c for c in cats if c}, chosen


def stroke_factor(maplibre_zoom: float) -> float:
    """該 zoom 下 mapsforge 會把線寬放大幾倍。"""
    raster_zoom = maplibre_zoom - ZOOM_OFFSET
    return STROKE_BASE ** max(raster_zoom - 12, 0)


def zoom_scaled(value: float) -> list[Any]:
    """把一個固定寬度包成隨 zoom 指數成長的 MapLibre 運算式。"""
    z0 = 12 + ZOOM_OFFSET            # raster z12 以下不放大
    top = round(value * STROKE_BASE ** (STROKE_ZOOM_MAX - z0), 4)
    return ["interpolate", ["exponential", STROKE_BASE], ["zoom"],
            z0, round(value, 4), STROKE_ZOOM_MAX, top]


def normalize_dash(arr: list[float]) -> list[float] | None:
    """去掉 0 長度的段。

    mapsforge 用開頭的 0 表示相位偏移（`0,16,3,0` = 空 16 再畫 3），MapLibre
    不接受 0 且沒有相位參數。把環狀序列從一段非零實線開始重走一遍，順手把
    被 0 隔開的同型段合併，`0,16,3,0` 就還原成 `3,16`。相位會丟掉，但花色對。
    """
    n = len(arr)
    if n < 2 or n % 2:
        return None
    seq = [(i % 2 == 0, float(v)) for i, v in enumerate(arr)]
    start = next((i for i, (is_dash, v) in enumerate(seq) if is_dash and v > 0), None)
    if start is None:
        return None
    out: list[list[Any]] = []
    for k in range(n):
        is_dash, v = seq[(start + k) % n]
        if v == 0:
            continue
        if out and out[-1][0] == is_dash:
            out[-1][1] += v
        else:
            out.append([is_dash, v])
    if len(out) % 2 or not out:
        return None
    return [round(v, 4) for _, v in out]


def key_filter(k: str, v: str) -> list[Any] | None:
    """把一條 rule 的 k/v 轉成 MapLibre filter（舊式語法，相容性最好）。

    k 和 v 都可以用 | 列多個（RuleBuilder 對兩者都跑 SPLIT_PATTERN）。主題裡有
    78 條多鍵規則，森林就是其中之一（`k="natural|landuse" v="forest|wood"`）——
    早先把 k 當成單一字串，這些規則全部被判定成「不可能命中」而剪掉，所以整張
    圖沒有任何 landuse 填色。

    命中條件照 PositiveRule.matchesAnyTag：**同一個 tag** 的 key 在 key 清單裡、
    且 value 在 value 清單裡。所以是「逐 key 各自比對後取聯集」，不是把 key 與
    value 兩組條件拆開各自成立。

    `~`（non-exclusive negation）照 NegativeRule 的註解：
        matches when either KEY is not present
        or KEY is present and any VALUE is present
    """
    if k == "*":
        return None  # AnyMatcher：對任何 tag 都成立 → 不加條件
    keys = k.split("|")
    values = v.split("|")
    negate = "~" in values
    present = [x for x in values if x not in ("~", "*")]
    any_value = "*" in values

    def per_key(key: str) -> list[Any] | None:
        if any_value:
            return ["has", key]  # 有值就算，present 是子集
        if not present:
            return None
        return ["in", key, *present] if len(present) > 1 else ["==", key, present[0]]

    hits = [c for c in (per_key(key) for key in keys) if c is not None]
    positive: list[Any] | None = None
    if hits:
        positive = hits[0] if len(hits) == 1 else ["any", *hits]

    if not negate:
        return positive

    # KEY 全都不存在
    absent = [["!has", key] for key in keys]
    no_key: list[Any] = absent[0] if len(absent) == 1 else ["all", *absent]
    if positive is None:
        return no_key
    return ["any", no_key, positive]


class Translator:
    def __init__(self, source: str, source_layer: str,
                 tag_index: dict[str, set[str] | None] | None,
                 sprite: set[str] | None = None,
                 categories: set[str] | None = None):
        self.source = source
        self.source_layer = source_layer
        self.tags = tag_index
        self.sprite = sprite
        self.missing_icons: set[str] = set()
        self.categories = categories
        self.cat_pruned = 0
        self.layers: list[dict[str, Any]] = []
        self.n = 0
        self.pruned = 0

    # ---- 資料驅動的剪枝 ----
    def ordered_layers(self) -> list[dict[str, Any]]:
        """輸出時的圖層順序。

        mapsforge 是先 drawWays() 再 drawMapElements()，也就是**所有標記都畫在
        最上層**（反組譯 DatabaseRenderer 確認過），所以 symbol 層一律移到最後。

        再來是排擠順序。MapLibre 的 PauseablePlacement 從
        `order.length - 1` 往回跑，**陣列越後面越先放置、越不會被擠掉**；
        mapsforge 則是 priority 越大越優先。所以 symbol 之間依 priority
        由小到大排，山頂（250）就會落在最後而穩穩畫出來。
        """
        ways = [L for L in self.layers if L["type"] != "symbol"]
        marks = [L for L in self.layers if L["type"] == "symbol"]
        marks.sort(key=lambda L: L["_priority"])   # list.sort 穩定，同分維持原順序
        out = ways + marks
        for L in out:
            L.pop("_priority", None)
        return out

    def cat_visible(self, el: ET.Element) -> bool:
        """對應 RenderThemeHandler.isVisible：沒有 cat，或 cat 在啟用集合裡。"""
        if self.categories is None:
            return True
        cat = el.get("cat")
        return cat is None or cat in self.categories

    def can_match(self, k: str, v: str) -> bool:
        """這條規則在實際抽出來的資料裡有沒有可能命中。

        主題涵蓋整個 OSM 標籤宇宙，但 .map 只留了 tag-mapping 指定的那些。
        翻譯全部會產出近兩千個 style layer，其中一大半是死的。
        """
        if self.tags is None or k == "*":
            return True
        values = v.split("|")
        if "~" in values:
            return True  # 「不存在」永遠可能成立
        # k 可以是多鍵（`natural|landuse`），任何一個有機會命中就不能剪。
        return any(self._key_can_match(key, values) for key in k.split("|"))

    def _key_can_match(self, k: str, values: list[str]) -> bool:
        if k not in self.tags:
            return False
        present = self.tags[k]
        if present is None:
            return True  # 值太多的 key（name / ele / ref）不剪
        if "*" in values:
            return True
        return any(x in present for x in values if x != "*")

    def walk(
        self,
        el: ET.Element,
        conds: list[Any],
        zmin: int | None,
        zmax: int | None,
        geom: set[str],
        closed: str | None,
    ) -> None:
        for child in el:
            tag = child.tag.replace(NS, "")
            if tag == "rule":
                if not self.cat_visible(child):
                    # isVisible(rule) 為 false 時 mapsforge 不會把它接進父規則，
                    # 整個子樹等於不存在。
                    self.cat_pruned += 1
                    continue
                k = child.get("k", "*")
                v = child.get("v", "*")
                if not self.can_match(k, v):
                    self.pruned += 1
                    continue
                f = key_filter(k, v)
                e = child.get("e", "any")
                g = {"way", "node"} if e == "any" else {e}
                nz_min = max(zmin or 0, int(child.get("zoom-min", 0)))
                zm = child.get("zoom-max")
                nz_max = min(zmax if zmax is not None else 99, int(zm) if zm else 99)
                self.walk(
                    child,
                    conds + ([f] if f else []),
                    nz_min,
                    nz_max,
                    geom & g if geom else g,
                    child.get("closed", closed),
                )
            else:
                self.emit(tag, child, conds, zmin, zmax, geom, closed)

    def emit(
        self,
        tag: str,
        el: ET.Element,
        conds: list[Any],
        zmin: int | None,
        zmax: int | None,
        geom: set[str],
        closed: str | None,
    ) -> None:
        if not self.cat_visible(el):
            self.cat_pruned += 1
            return
        maker = {
            "line": self.line,
            "area": self.area,
            "caption": self.caption,
            "pathText": self.path_text,
            "circle": self.circle,
            "symbol": self.symbol,
            "lineSymbol": self.line_symbol,
        }.get(tag)
        if maker is None:
            return
        layer = maker(el)
        if layer is None:
            return
        # 畫在線／面上的注記要拉開碰撞距離，見 WAY_TEXT_PADDING。
        if tag in ("caption", "pathText") and "node" not in geom:
            layer.setdefault("layout", {})["text-padding"] = WAY_TEXT_PADDING
        self.n += 1
        layer["id"] = f"{tag}-{self.n}"
        layer["source"] = self.source
        layer["source-layer"] = self.source_layer

        layer["_priority"] = float(el.get("priority") or 0)

        f: list[Any] = ["all", *conds]
        # mapsforge 的 closed 判斷對應 GeoJSON 的幾何型別
        if closed == "yes":
            f.append(["==", "$type", "Polygon"])
        elif closed == "no":
            f.append(["==", "$type", "LineString"])
        elif "node" in geom and "way" not in geom:
            f.append(["==", "$type", "Point"])
        if len(f) > 1:
            layer["filter"] = f
        if zmin:
            mz = zmin + ZOOM_OFFSET
            if mz > 0:
                layer["minzoom"] = mz
        if zmax is not None and zmax < 99:
            # 主題的 zoom-max 是含端點，MapLibre 的 maxzoom 是排除上界。
            layer["maxzoom"] = zmax + 1 + ZOOM_OFFSET
        self.layers.append(layer)

    # ---- 各繪製元素 ----
    def line(self, el: ET.Element) -> dict[str, Any] | None:
        paint: dict[str, Any] = {}
        c = color(el.get("stroke"))
        if c:
            paint["line-color"] = c

        # scale="none" 時 mapsforge 把 scaleFactor 直接設成 1，連 lineScale 都不套。
        scale = el.get("scale", "stroke")
        raw = num(el.get("stroke-width")) or 0.0
        if raw <= 0:
            raw = 1.0 / WIDTH_SCALE  # 維持既有「沒寫就當 1px」的行為
        base = raw if scale == "none" else round(raw * WIDTH_SCALE, 4)
        paint["line-width"] = base if scale == "none" else zoom_scaled(base)

        dash = el.get("stroke-dasharray")
        if dash:
            try:
                arr = normalize_dash([float(x) for x in dash.split(",")])
            except ValueError:
                arr = None
            if arr:
                # MapLibre 的 dasharray 單位是「線寬的倍數」
                # （spec: "The lengths are later scaled by the line width."）。
                if scale == "all":
                    # 虛線與線寬同步放大 → 倍數固定。
                    paint["line-dasharray"] = [round(x / raw, 4) for x in arr]
                elif scale == "none":
                    paint["line-dasharray"] = [round(x / base, 4) for x in arr]
                else:
                    # 預設的 Scale.STROKE：線變粗但虛線長度不變，所以倍數要逐級
                    # 反向補償。mapsforge 的倍率本來就按整數 zoom 量化，用 step
                    # 表達剛好一致。
                    z0 = 12 + ZOOM_OFFSET
                    # step 的輸出值若是陣列，一定要包成 ["literal", [...]]，
                    # 否則 MapLibre 會把第一個元素當成運算子名稱。
                    def units(factor: float) -> list[Any]:
                        return ["literal", [round(x / (base * factor), 4) for x in arr]]

                    step: list[Any] = ["step", ["zoom"], units(1.0)]
                    for m in range(z0 + 1, STROKE_ZOOM_MAX + 1):
                        step.append(m)
                        step.append(units(stroke_factor(m)))
                    paint["line-dasharray"] = step

        dy = num(el.get("dy"), WIDTH_SCALE)
        if dy:
            # dyScaled 也吃同一個 scaleFactor。
            paint["line-offset"] = dy if scale == "none" else zoom_scaled(dy)

        layout = {}
        cap = el.get("stroke-linecap")
        if cap in ("butt", "round", "square"):
            layout["line-cap"] = cap
        out: dict[str, Any] = {"type": "line", "paint": paint}
        if layout:
            out["layout"] = layout
        return out

    def area(self, el: ET.Element) -> dict[str, Any] | None:
        paint: dict[str, Any] = {}
        fill = color(el.get("fill"))
        if fill:
            paint["fill-color"] = fill
            if el.get("stroke"):
                paint["fill-outline-color"] = color(el.get("stroke"))
        pattern = self.icon(el)
        if pattern:
            # fill-pattern 沒有縮放參數，圖樣照 sprite 的原尺寸鋪，所以
            # build_sprite.py 才要按「實際被引用的尺寸」各存一份。
            paint["fill-pattern"] = pattern
        if not paint:
            return None
        return {"type": "fill", "paint": paint}

    def icon(self, el: ET.Element) -> str | None:
        """把 src + symbol-width/height 對回 sprite 裡的名稱。"""
        src = el.get("src")
        if not src or self.sprite is None:
            return None
        path = src.removeprefix("file:")
        w, h = el.get("symbol-width"), el.get("symbol-height")
        if w and h:
            size = (int(w), int(h))
        elif w:
            size = (int(w), int(w))
        elif h:
            size = (int(h), int(h))
        else:
            size = (DEFAULT_SIZE, DEFAULT_SIZE)
        name = sprite_name(path, *size)
        if name not in self.sprite:
            self.missing_icons.add(name)
            return None
        return name

    def symbol(self, el: ET.Element) -> dict[str, Any] | None:
        name = self.icon(el)
        if not name:
            return None
        layout: dict[str, Any] = {
            "icon-image": name,
            # 主題已經指定過尺寸，sprite 就是那個尺寸，不要再縮。
            "icon-size": 1,
            # 不要開 allow-overlap：mapsforge 自己會做標記碰撞偵測
            # （LabelPlacement），全部畫出來的話市區會被圖示淹沒。
            # MapLibre 的預設 false 就是對應的行為。
        }
        self.apply_priority(el, layout, icon=True)
        return {"type": "symbol", "layout": layout}

    def apply_priority(self, el: ET.Element, layout: dict[str, Any], *, icon: bool) -> None:
        """把 mapsforge 的 priority / display 轉成 MapLibre 的排擠規則。

        主題有 599 個元素標了 priority（山頂 220-250、一般店家 -5），沒有翻的話
        MapLibre 會讓路邊的雜項注記把山頂擠掉 —— 對登山圖來說剛好是最不能掉的
        那一類。MapLibre 的 symbol-sort-key 是**升冪**先放，所以取負號。
        """
        pr = el.get("priority")
        if pr is not None:
            try:
                layout["symbol-sort-key"] = -float(pr)
            except ValueError:
                pass
        if el.get("display") == "always":
            # mapsforge 的 display="always" 就是不參與碰撞。
            layout["icon-allow-overlap" if icon else "text-allow-overlap"] = True
            layout["icon-ignore-placement" if icon else "text-ignore-placement"] = True

    def line_symbol(self, el: ET.Element) -> dict[str, Any] | None:
        name = self.icon(el)
        if not name:
            return None
        repeat = num(el.get("repeat-gap"), WIDTH_SCALE, 60) or 60
        layout: dict[str, Any] = {
            "icon-image": name,
            "icon-size": 1,
            "symbol-placement": "line",
            "symbol-spacing": repeat,
            "icon-rotation-alignment": "map",
        }
        self.apply_priority(el, layout, icon=True)
        return {"type": "symbol", "layout": layout}

    def caption(self, el: ET.Element) -> dict[str, Any] | None:
        k = el.get("k")
        if not k:
            return None
        size = num(el.get("font-size"), TEXT_SCALE, 12) or 12
        layout: dict[str, Any] = {
            "text-field": ["get", k],
            "text-size": size,
            "text-font": ["Noto Sans Regular"],
            "text-max-width": 8,
        }
        dy = num(el.get("dy"))
        if dy:
            layout["text-offset"] = [0, round(dy / size, 3)]
        # mapsforge 的 position 決定注記相對錨點的方位。
        pos = el.get("position")
        anchor = {
            "above": "bottom", "below": "top",
            "left": "right", "right": "left",
            "above_left": "bottom-right", "above_right": "bottom-left",
            "below_left": "top-right", "below_right": "top-left",
            "center": "center",
        }.get(pos or "")
        if anchor:
            layout["text-anchor"] = anchor
        self.apply_priority(el, layout, icon=False)
        paint: dict[str, Any] = {"text-color": color(el.get("fill")) or "#000000"}
        halo = color(el.get("stroke"))
        if halo:
            paint["text-halo-color"] = halo
            paint["text-halo-width"] = num(el.get("stroke-width"), 1.0, 1) or 1
        return {"type": "symbol", "layout": layout, "paint": paint}

    def path_text(self, el: ET.Element) -> dict[str, Any] | None:
        base = self.caption(el)
        if base is None:
            return None
        base["layout"]["symbol-placement"] = "line"
        base["layout"].pop("text-offset", None)
        return base

    def circle(self, el: ET.Element) -> dict[str, Any] | None:
        paint: dict[str, Any] = {"circle-radius": num(el.get("radius"), 1.0, 3) or 3}
        f = color(el.get("fill"))
        if f:
            paint["circle-color"] = f
        s = color(el.get("stroke"))
        if s:
            paint["circle-stroke-color"] = s
            paint["circle-stroke-width"] = num(el.get("stroke-width"), 1.0, 1) or 1
        return {"type": "circle", "paint": paint}


def load_tag_index(path: Path) -> dict[str, set[str] | None]:
    """`null` 代表「值太多所以不剪枝」（name / ele / ref 之類）。"""
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {k: (set(v) if v is not None else None) for k, v in raw.items()}


def with_hillshade(layers: list[dict[str, Any]], enabled: bool,
                   pyramid_max: int | None = None) -> list[dict[str, Any]]:
    """把陰影插在最後一個面填色之後、線之前。

    mapsforge 是把 hillshading 當成 layer=5 的繪製指令，實際會蓋在大部分的線
    上面；但陰影是乘算（alpha 疊黑），蓋在道路上只會讓道路變暗，反而不如
    壓在線下面好看。這裡選擇插在填色與線之間 —— 底色有陰影、道路與注記保持乾淨。

    陰影圖磚本身已經把 alpha 烤進去了（見 build_hillshade.py），所以
    raster-opacity 維持 1，不要再乘一次。

    **超過原生解析度就不畫**（`maxzoom`）。陰影只做到金字塔 z13，再往上
    MapLibre 會把圖磚拉大並逐張內插；每張各自內插、邊緣沒有鄰磚的像素可參考，
    兩側就對不起來，實機上看得到一格一格的淡淡矩形接縫。tileSize 是 256，
    所以金字塔 z13 的原生比例尺落在 MapLibre z12 —— 圖層上界設成金字塔的
    最大 zoom（MapLibre 的 maxzoom 不含上界）剛好在那裡收掉。
    """
    if not enabled:
        return layers
    last_fill = max((i for i, L in enumerate(layers) if L["type"] == "fill"), default=-1)
    shade: dict[str, Any] = {
        "id": "hillshade",
        "type": "raster",
        "source": "hillshade",
        "paint": {"raster-opacity": 1, "raster-resampling": "linear"},
    }
    if pyramid_max is not None:
        shade["maxzoom"] = pyramid_max
    return layers[:last_fill + 1] + [shade] + layers[last_fill + 1:]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("theme", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--source", default="rudy")
    ap.add_argument("--source-layer", default="rudy")
    ap.add_argument("--tiles-url", default="https://map.mitalivana.org/vector/{z}/{x}/{y}.pbf")
    ap.add_argument("--glyphs", default="https://map.mitalivana.org/vector/fonts/{fontstack}/{range}.pbf")
    ap.add_argument("--tag-index", type=Path,
                    help="從實際抽出的資料產生的 {key: [values]}，用來剪掉永遠不會命中的規則")
    ap.add_argument("--max-zoom", type=int, default=15)
    ap.add_argument("--sprite-index", type=Path,
                    help="build_sprite.py 產生的 sprite.json，用來把 src 對回圖示名稱")
    ap.add_argument("--sprite-url", default="https://map.mitalivana.org/vector/sprite")
    ap.add_argument("--hillshade-url", default=None,
                    help="山體陰影圖磚的 URL 樣板；給了才會加進 style")
    ap.add_argument("--hillshade-zoom", default="9,13",
                    help="陰影圖磚金字塔的 zoom 範圍（raster 慣例），預設 9,13")
    ap.add_argument("--style", default=None,
                    help="stylemenu 裡的樣式 id，預設用主題的 defaultvalue。"
                         "raster 管線用的是 elmt-hiking（rudy.properties 的 style=）")
    ap.add_argument("--overlay", action="append", default=None,
                    help="強制開啟的 overlay id（可重複），不給就照主題各 layer 的 enabled")
    args = ap.parse_args()

    tree = ET.parse(args.theme)
    root = tree.getroot()

    tags = load_tag_index(args.tag_index) if args.tag_index else None
    sprite = None
    if args.sprite_index:
        sprite = set(json.loads(args.sprite_index.read_text()))
    # 山體陰影是預先算好的 256px raster 金字塔。tileSize=256 會讓 MapLibre 自己
    # 處理「主題 zoom 與 MapLibre zoom 差一級」那件事：MapLibre z12 去要金字塔的
    # z13，正好對上 mapsforge 的 zoom 慣例。
    hillshade_source: dict[str, Any] = {}
    hs_min, hs_max = (int(v) for v in args.hillshade_zoom.split(","))
    if args.hillshade_url:
        hillshade_source["hillshade"] = {
            "type": "raster",
            "tiles": [args.hillshade_url],
            "tileSize": 256,
            "minzoom": hs_min,
            "maxzoom": hs_max,
        }

    cats = enabled_categories(root, args.style, args.overlay)
    categories, chosen = cats if cats else (None, None)
    tr = Translator(args.source, args.source_layer, tags, sprite, categories)
    tr.walk(root, [], None, None, set(), None)

    style = {
        "version": 8,
        "name": "Mitalivana Topo",
        "metadata": {
            "translated-from": args.theme.name,
            "style": chosen,
            "note": "Derived from Rudy Map (MOI.OSM Taiwan TOPO) theme; not the original map.",
        },
        "sources": {
            **hillshade_source,
            args.source: {
                "type": "vector",
                "tiles": [args.tiles_url],
                "minzoom": 0,
                "maxzoom": args.max_zoom,
                "attribution": "資料基於魯地圖 Taiwan TOPO・© OpenStreetMap 貢獻者（ODbL）・內政部 20 公尺網格 DTM",
            }
        },
        "glyphs": args.glyphs,
        **({"sprite": args.sprite_url} if sprite else {}),
        "layers": [
            {"id": "background", "type": "background", "paint": {"background-color": "#FFFFFF"}},
            *with_hillshade(tr.ordered_layers(), bool(args.hillshade_url), hs_max),
        ],
    }
    args.out.write_text(json.dumps(style, ensure_ascii=False, indent=1), encoding="utf-8")
    kinds: dict[str, int] = {}
    for layer in tr.layers:
        kinds[layer["type"]] = kinds.get(layer["type"], 0) + 1
    if categories is not None:
        print(f"樣式 {chosen}：啟用 {len(categories)} 個 category")
    print(f"翻譯出 {len(tr.layers):,} 個 style layer"
          f"（剪掉 {tr.pruned:,} 條不可能命中的規則、{tr.cat_pruned:,} 條未啟用的 category）")
    print("   ", kinds)
    if tr.missing_icons:
        print(f"    sprite 缺 {len(tr.missing_icons)} 個圖示："
              f"{', '.join(sorted(tr.missing_icons)[:5])}…")
    print(f"→ {args.out} ({args.out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
