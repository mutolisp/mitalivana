VERSION     := 1.0.0
APP_NAME    := checklister-ng
DIST_DIR    := dist
FRONTEND    := frontend
PYTHON       := python3.11
BACKEND_VENV := backend/venv

# Platform detection
UNAME_S := $(shell uname -s)

# ─── Default ──────────────────────────────────────────────
.PHONY: all frontend backend pkg pkg-dmg pkg-win taicol icon clean help test

all: backend frontend

.PHONY: all backend frontend run dev pkg pkg-dmg pkg-win test taicol icon clean help \
	datasets datasets-verify datasets-upload \
	rudymap-config rudymap-serve rudymap-render rudymap-qa rudymap-optimize rudymap-pack rudymap-verify rudymap-verify-published rudymap-upload

help:
	@echo "Usage:"
	@echo "  make              Build backend venv + frontend"
	@echo "  make frontend     Build frontend only"
	@echo "  make backend      Setup backend venv + install deps"
	@echo "  make run          Start dev server (port 8964)"
	@echo "  make dev          Start backend + frontend dev servers"
	@echo "  make pkg          Build platform package (dmg on macOS)"
	@echo "  make pkg-dmg      Build macOS .app + .dmg"
	@echo "  make pkg-win      Build Windows .exe (run on Windows)"
	@echo "  make test          Run regression tests (pytest)"
	@echo "  make taicol        Import TaiCOL CSV (auto-find latest or CSV=path)"
	@echo "  make datasets      Build downloadable checklist modules (dist/datasets)"
	@echo "  make datasets-verify  Verify modules answer like the master DB"
	@echo "  make rudymap-*     Rudy map offline tile pipeline (see backend/scripts/rudymap/README.md)"
	@echo "  make icon         Generate .ico/.icns from icons/checklister-ng_icons.png"
	@echo "  make clean        Remove build artifacts"

# ─── Backend ──────────────────────────────────────────────
backend: $(BACKEND_VENV)/bin/activate

$(BACKEND_VENV)/bin/activate: requirements.txt
	$(PYTHON) -m venv $(BACKEND_VENV)
	$(BACKEND_VENV)/bin/pip install --upgrade pip
	$(BACKEND_VENV)/bin/pip install -r requirements.txt
	touch $@

# ─── Frontend ─────────────────────────────────────────────
frontend: $(FRONTEND)/build/index.html

$(FRONTEND)/build/index.html: $(FRONTEND)/package.json $(shell find $(FRONTEND)/src -type f 2>/dev/null)
	cd $(FRONTEND) && npm install && npm run build

# ─── Run ──────────────────────────────────────────────────
run: all
	$(BACKEND_VENV)/bin/python run.py --port 8964

dev:
	@echo "Starting backend (port 8964)..."
	$(BACKEND_VENV)/bin/uvicorn backend.main:app --reload --port 8964 &
	@echo "Starting frontend dev server..."
	cd $(FRONTEND) && npm run dev

# ─── Package (auto-detect platform) ──────────────────────
pkg:
ifeq ($(UNAME_S),Darwin)
	$(MAKE) pkg-dmg
else
	$(MAKE) pkg-win
endif

# ─── macOS DMG ────────────────────────────────────────────
pkg-dmg: frontend backend
	$(BACKEND_VENV)/bin/pip install -q pyinstaller
	$(BACKEND_VENV)/bin/pyinstaller checklister.spec --clean -y
	@echo "==> Creating DMG..."
	rm -rf $(DIST_DIR)/dmg-staging
	mkdir -p $(DIST_DIR)/dmg-staging
	cp -R $(DIST_DIR)/$(APP_NAME).app $(DIST_DIR)/dmg-staging/
	ln -s /Applications $(DIST_DIR)/dmg-staging/Applications
	rm -f $(DIST_DIR)/$(APP_NAME).dmg
	hdiutil create \
		-volname "$(APP_NAME)" \
		-srcfolder $(DIST_DIR)/dmg-staging \
		-ov -format UDZO \
		$(DIST_DIR)/$(APP_NAME).dmg
	rm -rf $(DIST_DIR)/dmg-staging
	@echo "==> Done: $(DIST_DIR)/$(APP_NAME).dmg"
	@du -sh $(DIST_DIR)/$(APP_NAME).dmg

# ─── Windows EXE ──────────────────────────────────────────
pkg-win: frontend
	pyinstaller checklister_win32.spec --clean -y
	@echo "==> Done: $(DIST_DIR)/$(APP_NAME).exe"

# ─── Test ─────────────────────────────────────────────────
test: backend
	$(BACKEND_VENV)/bin/python -m pytest tests/ -v

# ─── TaiCOL Import ────────────────────────────────────────
CSV ?= $(shell ls -t references/TaiCOL_name_*.csv 2>/dev/null | head -1)

taicol: backend
	@if [ -z "$(CSV)" ]; then echo "Error: No TaiCOL CSV found in references/"; exit 1; fi
	@echo "==> Importing TaiCOL from: $(CSV)"
	$(BACKEND_VENV)/bin/python -m backend.services.taicol_import "$(CSV)"

# ─── Dataset modules (R2) ─────────────────────────────────
# 把 backend/twnamelist.db 拆成可獨立下載的模組（tw-taicol / jp-ylist /
# tw-keys），產出 + manifest 在 dist/datasets/。母檔本身不會被改動。
# 每次名錄或檢索表更新後：make datasets && make datasets-verify
DATASETS_OUT := dist/datasets
datasets: backend
	$(BACKEND_VENV)/bin/python -m backend.scripts.datasets.build_datasets \
		--out $(DATASETS_OUT) $(if $(VERSION),--version $(VERSION),) $(if $(ONLY),--only $(ONLY),)

# 等價性驗證：模組回答必須與母檔一致（結構 / 列數 / 查詢 / 衍生索引 /
# 檢索表 taxon 解析 / 跨區俗名）。名錄更新後一定要跑。
datasets-verify: backend
	$(BACKEND_VENV)/bin/python -m backend.scripts.datasets.verify_datasets --out $(DATASETS_OUT)

# 上傳到 R2。版本目錄不覆寫、latest/manifest.json 最後才傳（半套版本不會被 app 看到）。
# 需要 ~/.mitalivana-r2.env 的 S3 憑證，或 wrangler 已登入。
# make datasets-upload R2_BUCKET=mitalivana [ONLY=tw-keys] [DRY=1]
datasets-upload: backend
	@test -n "$(R2_BUCKET)" || { echo "需要 R2_BUCKET=..."; exit 1; }
	$(BACKEND_VENV)/bin/python -m backend.scripts.datasets.upload_datasets \
		--out $(DATASETS_OUT) --bucket $(R2_BUCKET) \
		$(if $(BASE_URL),--base-url $(BASE_URL),) $(if $(ONLY),--only $(ONLY),) $(if $(DRY),--dry-run,)

# ─── Rudy map offline tiles ───────────────────────────────
# 完整流程與前置需求見 backend/scripts/rudymap/README.md
RUDY_DIR     := build/rudymap
RUDY_SRC     := $(RUDY_DIR)/src
RUDY_TILES   := $(RUDY_DIR)/tiles
RUDY_PACK    := $(RUDY_DIR)/pack
RUDY_PORT    := 8088
ZMIN         := 7
ZMAX         := 15
QUALITY      := 90-100

# text/symbol/line scale 放大是刻意的：圖磚是 256px，在 3× DPR 手機上會被放大算繪，
# scale=1.0 的地名在野外單手操作時太小。實測體積只差 0.3%。
#
# hillshading-magnitude 是**乘以**主題檔自己的強度，不是絕對值。第一版從
# MapsforgeSrv 範例抄了 2，等於把陰影加倍，把等高線整片糊掉（與山林日誌並排
# 一看就知道）。1 = 尊重主題設定。
#
# hillshading-zoom-max=13：z14 以上完全不做陰影。那是等高線最需要乾淨的地方，
# 而且 z14+z15 佔全部圖磚 95%，關掉等於整包少約 25%；縮小看山勢時 z13 以下
# 仍有立體感。
rudymap-config:
	@test -d $(RUDY_SRC)/map   || { echo "缺 $(RUDY_SRC)/map，見 README 前置步驟 3"; exit 1; }
	@test -d $(RUDY_SRC)/style || { echo "缺 $(RUDY_SRC)/style，見 README 前置步驟 3"; exit 1; }
	@test -d $(RUDY_SRC)/dem   || { echo "缺 $(RUDY_SRC)/dem，見 README 前置步驟 3"; exit 1; }
	@mkdir -p $(RUDY_DIR)/config/tasks
	@printf 'terminate=true\nhost=127.0.0.1\nport=$(RUDY_PORT)\ncache-control=0\nrequestlog-format=\n' \
		> $(RUDY_DIR)/config/server.properties
	@printf 'mapfiles=%s/map\nworldmap=false\nlanguage=zh\nthemefile=%s/style/MOI_OSM.xml\nstyle=elmt-hiking\ndemfolder=%s/dem\nhillshading-algorithm=simple(0.4,1)\nhillshading-magnitude=1\nhillshading-zoom-max=13\ndevice-scale=1\nuser-scale=1\ntext-scale=1.25\nsymbol-scale=1.15\nline-scale=1.15\n' \
		"$(abspath $(RUDY_SRC))" "$(abspath $(RUDY_SRC))" "$(abspath $(RUDY_SRC))" \
		> $(RUDY_DIR)/config/tasks/rudy.properties
	@mkdir -p $(RUDY_SRC)/style-hs
	@test -f $(RUDY_SRC)/style-hs/hillshade_only.xml || \
		cp backend/scripts/rudymap/hillshade_only.xml $(RUDY_SRC)/style-hs/hillshade_only.xml
	@printf 'mapfiles=%s/map\nworldmap=false\nlanguage=zh\nthemefile=%s/style-hs/hillshade_only.xml\ndemfolder=%s/dem\nhillshading-algorithm=simple(0.4,1)\nhillshading-magnitude=1\nhillshading-zoom-max=13\ndevice-scale=1\nuser-scale=1\n' \
		"$(abspath $(RUDY_SRC))" "$(abspath $(RUDY_SRC))" "$(abspath $(RUDY_SRC))" \
		> $(RUDY_DIR)/config/tasks/hillshade.properties
	@echo "==> 設定已產生於 $(RUDY_DIR)/config（含 rudy 與 hillshade 兩個 task）"

rudymap-serve:
	java -Xmx4g -jar $(RUDY_SRC)/mapsforgesrv-fatjar.jar -c $(RUDY_DIR)/config

rudymap-render: backend
	$(BACKEND_VENV)/bin/python -m backend.scripts.rudymap.render_tiles \
		--out $(RUDY_TILES) --srv http://127.0.0.1:$(RUDY_PORT) --task rudy --zmin $(ZMIN) --zmax $(ZMAX)

rudymap-qa: backend
	$(BACKEND_VENV)/bin/python -m backend.scripts.rudymap.compare_quality \
		--tiles $(RUDY_TILES) --out build/rudymap-qa

rudymap-optimize: backend
	$(BACKEND_VENV)/bin/python -m backend.scripts.rudymap.optimize_tiles \
		--tiles $(RUDY_TILES) --out $(RUDY_DIR)/tiles-opt --quality $(QUALITY)

# make rudymap-pack VERSION=2026-09 BASE_URL=https://<r2-host>/rudymap/2026-09
rudymap-pack: backend
	@test -n "$(BASE_URL)" || { echo "需要 BASE_URL=..."; exit 1; }
	$(BACKEND_VENV)/bin/python -m backend.scripts.rudymap.pack_tiles \
		--tiles $(RUDY_TILES) --out $(RUDY_PACK) --version $(VERSION) --base-url $(BASE_URL) \
		$(if $(wildcard $(RUDY_SRC)/map/*.poi),--poi $(firstword $(wildcard $(RUDY_SRC)/map/*.poi)),)

rudymap-verify: backend
	$(BACKEND_VENV)/bin/python -m backend.scripts.rudymap.verify_pack --pack $(RUDY_PACK)

# 驗證線上實況（每次發新版都跑）
rudymap-verify-published: backend
	$(BACKEND_VENV)/bin/python -m backend.scripts.rudymap.verify_published

# make rudymap-upload R2_BUCKET=<bucket> R2_BASE_URL=https://<host>/rudymap [DRY=1]
# 需要 wrangler 已登入（npx wrangler login）或設好 CLOUDFLARE_API_TOKEN。
rudymap-upload: backend
	@test -n "$(R2_BUCKET)"   || { echo "需要 R2_BUCKET=..."; exit 1; }
	@test -n "$(R2_BASE_URL)" || { echo "需要 R2_BASE_URL=..."; exit 1; }
	$(BACKEND_VENV)/bin/python -m backend.scripts.rudymap.upload_pack \
		--pack $(RUDY_PACK) --bucket $(R2_BUCKET) --base-url $(R2_BASE_URL) \
		$(if $(DRY),--dry-run,)

# ─── Icon ─────────────────────────────────────────────────
icon:
	$(BACKEND_VENV)/bin/python icons/gen_icons.py

# ─── Clean ────────────────────────────────────────────────
clean:
	rm -rf build $(DIST_DIR) $(FRONTEND)/build
	rm -rf *.egg-info __pycache__
