"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const atom_1 = require("atom");
const electron_1 = require("electron");
const fileUriToPath = require("file-uri-to-path");
const util_1 = require("../util");
class WebviewHandler {
    constructor(init) {
        this.emitter = new atom_1.Emitter();
        this.disposables = new atom_1.CompositeDisposable();
        this.destroyed = false;
        this.zoomLevel = 0;
        this.replyCallbacks = new Map();
        this.replyCallbackId = 0;
        this._element = document.createElement('webview');
        this._element.classList.add('markdown-preview-plus', 'native-key-bindings');
        this._element.disablewebsecurity = 'true';
        this._element.nodeintegration = 'true';
        this._element.src = `file:///${__dirname}/../../client/template.html`;
        this._element.style.width = '100%';
        this._element.style.height = '100%';
        this._element.addEventListener('ipc-message', (e) => {
            switch (e.channel) {
                case 'zoom-in':
                    this.zoomIn();
                    break;
                case 'zoom-out':
                    this.zoomOut();
                    break;
                case 'did-scroll-preview':
                    this.emitter.emit('did-scroll-preview', e.args[0]);
                    break;
                case 'request-reply': {
                    const { id, request, result } = e.args[0];
                    const cb = this.replyCallbacks.get(id);
                    if (cb && request === cb.request) {
                        const callback = cb.callback;
                        callback(result);
                    }
                    break;
                }
            }
        });
        this._element.addEventListener('will-navigate', async (e) => {
            if (e.url.startsWith('file://')) {
                util_1.handlePromise(atom.workspace.open(fileUriToPath(e.url)));
            }
            else {
                electron_1.shell.openExternal(e.url);
            }
        });
        this.disposables.add(atom.styles.onDidAddStyleElement(() => {
            this.updateStyles();
        }), atom.styles.onDidRemoveStyleElement(() => {
            this.updateStyles();
        }), atom.styles.onDidUpdateStyleElement(() => {
            this.updateStyles();
        }));
        const onload = () => {
            if (this.destroyed)
                return;
            this._element.setZoomLevel(this.zoomLevel);
            this.updateStyles();
            init();
        };
        this._element.addEventListener('dom-ready', onload);
    }
    get element() {
        return this._element;
    }
    async runJS(js) {
        return new Promise((resolve) => this._element.executeJavaScript(js, false, resolve));
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.disposables.dispose();
        this._element.remove();
    }
    async update(html, renderLaTeX) {
        if (this.destroyed)
            return undefined;
        return this.runRequest('update-preview', {
            html,
            renderLaTeX,
        });
    }
    setSourceMap(map) {
        this._element.send('set-source-map', { map });
    }
    setUseGitHubStyle(value) {
        this._element.send('use-github-style', { value });
    }
    setBasePath(path) {
        this._element.send('set-base-path', { path });
    }
    init(atomHome, mathJaxConfig, mathJaxRenderer = util_1.atomConfig().mathConfig.latexRenderer) {
        this._element.send('init', {
            atomHome,
            mathJaxConfig,
            mathJaxRenderer,
        });
    }
    updateImages(oldSource, version) {
        this._element.send('update-images', {
            oldsrc: oldSource,
            v: version,
        });
    }
    async saveToPDF(filePath) {
        const opts = util_1.atomConfig().saveConfig.saveToPDFOptions;
        const customPageSize = parsePageSize(opts.customPageSize);
        const pageSize = opts.pageSize === 'Custom' ? customPageSize : opts.pageSize;
        if (pageSize === undefined) {
            throw new Error(`Failed to parse custom page size: ${opts.customPageSize}`);
        }
        const selection = await this.getSelection();
        const printSelectionOnly = selection ? opts.printSelectionOnly : false;
        const newOpts = Object.assign({}, opts, { pageSize,
            printSelectionOnly });
        await this.prepareSaveToPDF(newOpts);
        try {
            const data = await new Promise((resolve, reject) => {
                this._element.printToPDF(newOpts, (error, data) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve(data);
                });
            });
            await new Promise((resolve, reject) => {
                fs.writeFile(filePath, data, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
        finally {
            util_1.handlePromise(this.finishSaveToPDF());
        }
    }
    sync(line, flash) {
        this._element.send('sync', { line, flash });
    }
    async syncSource() {
        return this.runRequest('sync-source', {});
    }
    scrollSync(firstLine, lastLine) {
        this._element.send('scroll-sync', { firstLine, lastLine });
    }
    zoomIn() {
        this.zoomLevel += 0.1;
        this._element.setZoomLevel(this.zoomLevel);
    }
    zoomOut() {
        this.zoomLevel -= 0.1;
        this._element.setZoomLevel(this.zoomLevel);
    }
    resetZoom() {
        this.zoomLevel = 0;
        this._element.setZoomLevel(this.zoomLevel);
    }
    print() {
        this._element.print();
    }
    openDevTools() {
        this._element.openDevTools();
    }
    async reload() {
        await this.runRequest('reload', {});
        this._element.reload();
    }
    error(msg) {
        this._element.send('error', { msg });
    }
    async getTeXConfig() {
        return this.runRequest('get-tex-config', {});
    }
    async getSelection() {
        return this.runRequest('get-selection', {});
    }
    async runRequest(request, args) {
        const id = this.replyCallbackId++;
        return new Promise((resolve) => {
            this.replyCallbacks.set(id, {
                request: request,
                callback: (result) => {
                    this.replyCallbacks.delete(id);
                    resolve(result);
                },
            });
            const newargs = Object.assign({ id }, args);
            this._element.send(request, newargs);
        });
    }
    async prepareSaveToPDF(opts) {
        const [width, height] = getPageWidth(opts.pageSize);
        return this.runRequest('set-width', {
            width: opts.landscape ? height : width,
        });
    }
    async finishSaveToPDF() {
        return this.runRequest('set-width', { width: undefined });
    }
    updateStyles() {
        const styles = [];
        for (const se of atom.styles.getStyleElements()) {
            styles.push(se.innerHTML);
        }
        this._element.send('style', { styles });
    }
}
exports.WebviewHandler = WebviewHandler;
function parsePageSize(size) {
    if (!size)
        return undefined;
    const rx = /^([\d.,]+)(cm|mm|in)?x([\d.,]+)(cm|mm|in)?$/i;
    const res = size.replace(/\s*/g, '').match(rx);
    if (res) {
        const width = parseFloat(res[1]);
        const wunit = res[2];
        const height = parseFloat(res[3]);
        const hunit = res[4];
        return {
            width: convert(width, wunit),
            height: convert(height, hunit),
        };
    }
    else {
        return undefined;
    }
}
function convert(val, unit) {
    return val * unitInMicrons(unit);
}
function unitInMicrons(unit = 'mm') {
    switch (unit) {
        case 'mm':
            return 1000;
        case 'cm':
            return 10000;
        case 'in':
            return 25400;
    }
}
function getPageWidth(pageSize) {
    switch (pageSize) {
        case 'A3':
            return [297, 420];
        case 'A4':
            return [210, 297];
        case 'A5':
            return [148, 210];
        case 'Legal':
            return [216, 356];
        case 'Letter':
            return [216, 279];
        case 'Tabloid':
            return [279, 432];
        default:
            return [pageSize.width / 1000, pageSize.height / 1000];
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Vidmlldy1oYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL21hcmtkb3duLXByZXZpZXctdmlldy93ZWJ2aWV3LWhhbmRsZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSx5QkFBd0I7QUFDeEIsK0JBQWlFO0FBQ2pFLHVDQUE0QztBQUM1QyxrREFBa0Q7QUFFbEQsa0NBQW1EO0FBWW5ELE1BQWEsY0FBYztJQWN6QixZQUFZLElBQWdCO1FBYlosWUFBTyxHQUFHLElBQUksY0FBTyxFQUtsQyxDQUFBO1FBQ08sZ0JBQVcsR0FBRyxJQUFJLDBCQUFtQixFQUFFLENBQUE7UUFFekMsY0FBUyxHQUFHLEtBQUssQ0FBQTtRQUNqQixjQUFTLEdBQUcsQ0FBQyxDQUFBO1FBQ2IsbUJBQWMsR0FBRyxJQUFJLEdBQUcsRUFBK0IsQ0FBQTtRQUN2RCxvQkFBZSxHQUFHLENBQUMsQ0FBQTtRQUd6QixJQUFJLENBQUMsUUFBUSxHQUFHLFFBQVEsQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDLENBQUE7UUFDakQsSUFBSSxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLHVCQUF1QixFQUFFLHFCQUFxQixDQUFDLENBQUE7UUFDM0UsSUFBSSxDQUFDLFFBQVEsQ0FBQyxrQkFBa0IsR0FBRyxNQUFNLENBQUE7UUFDekMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxlQUFlLEdBQUcsTUFBTSxDQUFBO1FBQ3RDLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxHQUFHLFdBQVcsU0FBUyw2QkFBNkIsQ0FBQTtRQUNyRSxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxLQUFLLEdBQUcsTUFBTSxDQUFBO1FBQ2xDLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUE7UUFDbkMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxnQkFBZ0IsQ0FDNUIsYUFBYSxFQUNiLENBQUMsQ0FBaUMsRUFBRSxF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QUFFO1FBQ2hCLEtBQUssSUFBSTtZQUNQLE9BQU8sQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLENBQUE7UUFDbkIsS0FBSyxJQUFJO1lBQ1AsT0FBTyxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsQ0FBQTtRQUNuQixLQUFLLElBQUk7WUFDUCxPQUFPLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFBO1FBQ25CLEtBQUssT0FBTztZQUNWLE9BQU8sQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLENBQUE7UUFDbkIsS0FBSyxRQUFRO1lBQ1gsT0FBTyxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsQ0FBQTtRQUNuQixLQUFLLFNBQVM7WUFDWixPQUFPLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFBO1FBQ25CO1lBQ0UsT0FBTyxDQUFDLFFBQVEsQ0FBQyxLQUFLLEdBQUcsSUFBSSxFQUFFLFFBQVEsQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLENBQUE7S0FDekQ7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnXG5pbXBvcnQgeyBFbWl0dGVyLCBDb21wb3NpdGVEaXNwb3NhYmxlLCBDb25maWdWYWx1ZXMgfSBmcm9tICdhdG9tJ1xuaW1wb3J0IHsgV2Vidmlld1RhZywgc2hlbGwgfSBmcm9tICdlbGVjdHJvbidcbmltcG9ydCBmaWxlVXJpVG9QYXRoID0gcmVxdWlyZSgnZmlsZS11cmktdG8tcGF0aCcpXG5cbmltcG9ydCB7IGhhbmRsZVByb21pc2UsIGF0b21Db25maWcgfSBmcm9tICcuLi91dGlsJ1xuaW1wb3J0IHsgUmVxdWVzdFJlcGx5TWFwLCBDaGFubmVsTWFwIH0gZnJvbSAnLi4vLi4vc3JjLWNsaWVudC9pcGMnXG5cbmV4cG9ydCB0eXBlIFJlcGx5Q2FsbGJhY2tTdHJ1Y3Q8XG4gIFQgZXh0ZW5kcyBrZXlvZiBSZXF1ZXN0UmVwbHlNYXAgPSBrZXlvZiBSZXF1ZXN0UmVwbHlNYXBcbj4gPSB7XG4gIFtLIGluIGtleW9mIFJlcXVlc3RSZXBseU1hcF06IHtcbiAgICByZXF1ZXN0OiBLXG4gICAgY2FsbGJhY2s6IChyZXBseTogUmVxdWVzdFJlcGx5TWFwW0tdKSA9PiB2b2lkXG4gIH1cbn1bVF1cblxuZXhwb3J0IGNsYXNzIFdlYnZpZXdIYW5kbGVyIHtcbiAgcHVibGljIHJlYWRvbmx5IGVtaXR0ZXIgPSBuZXcgRW1pdHRlcjxcbiAgICB7fSxcbiAgICB7XG4gICAgICAnZGlkLXNjcm9sbC1wcmV2aWV3JzogeyBtaW46IG51bWJlcjsgbWF4OiBudW1iZXIgfVxuICAgIH1cbiAgPigpXG4gIHByb3RlY3RlZCBkaXNwb3NhYmxlcyA9IG5ldyBDb21wb3NpdGVEaXNwb3NhYmxlKClcbiAgcHJpdmF0ZSByZWFkb25seSBfZWxlbWVudDogV2Vidmlld1RhZ1xuICBwcml2YXRlIGRlc3Ryb3llZCA9IGZhbHNlXG4gIHByaXZhdGUgem9vbUxldmVsID0gMFxuICBwcml2YXRlIHJlcGx5Q2FsbGJhY2tzID0gbmV3IE1hcDxudW1iZXIsIFJlcGx5Q2FsbGJhY2tTdHJ1Y3Q+KClcbiAgcHJpdmF0ZSByZXBseUNhbGxiYWNrSWQgPSAwXG5cbiAgY29uc3RydWN0b3IoaW5pdDogKCkgPT4gdm9pZCkge1xuICAgIHRoaXMuX2VsZW1lbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCd3ZWJ2aWV3JylcbiAgICB0aGlzLl9lbGVtZW50LmNsYXNzTGlzdC5hZGQoJ21hcmtkb3duLXByZXZpZXctcGx1cycsICduYXRpdmUta2V5LWJpbmRpbmdzJylcbiAgICB0aGlzLl9lbGVtZW50LmRpc2FibGV3ZWJzZWN1cml0eSA9ICd0cnVlJ1xuICAgIHRoaXMuX2VsZW1lbnQubm9kZWludGVncmF0aW9uID0gJ3RydWUnXG4gICAgdGhpcy5fZWxlbWVudC5zcmMgPSBgZmlsZTovLy8ke19fZGlybmFtZX0vLi4vLi4vY2xpZW50L3RlbXBsYXRlLmh0bWxgXG4gICAgdGhpcy5fZWxlbWVudC5zdHlsZS53aWR0aCA9ICcxMDAlJ1xuICAgIHRoaXMuX2VsZW1lbnQuc3R5bGUuaGVpZ2h0ID0gJzEwMCUnXG4gICAgdGhpcy5fZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKFxuICAgICAgJ2lwYy1tZXNzYWdlJyxcbiAgICAgIChlOiBFbGVjdHJvbi5JcGNNZXNzYWdlRXZlbnRDdXN0b20pID0+IHtcbiAgICAgICAgc3dpdGNoIChlLmNoYW5uZWwpIHtcbiAgICAgICAgICBjYXNlICd6b29tLWluJzpcbiAgICAgICAgICAgIHRoaXMuem9vbUluKClcbiAgICAgICAgICAgIGJyZWFrXG4gICAgICAgICAgY2FzZSAnem9vbS1vdXQnOlxuICAgICAgICAgICAgdGhpcy56b29tT3V0KClcbiAgICAgICAgICAgIGJyZWFrXG4gICAgICAgICAgY2FzZSAnZGlkLXNjcm9sbC1wcmV2aWV3JzpcbiAgICAgICAgICAgIHRoaXMuZW1pdHRlci5lbWl0KCdkaWQtc2Nyb2xsLXByZXZpZXcnLCBlLmFyZ3NbMF0pXG4gICAgICAgICAgICBicmVha1xuICAgICAgICAgIC8vIHJlcGxpZXNcbiAgICAgICAgICBjYXNlICdyZXF1ZXN0LXJlcGx5Jzoge1xuICAgICAgICAgICAgY29uc3QgeyBpZCwgcmVxdWVzdCwgcmVzdWx0IH0gPSBlLmFyZ3NbMF1cbiAgICAgICAgICAgIGNvbnN0IGNiID0gdGhpcy5yZXBseUNhbGxiYWNrcy5nZXQoaWQpXG4gICAgICAgICAgICBpZiAoY2IgJiYgcmVxdWVzdCA9PT0gY2IucmVxdWVzdCkge1xuICAgICAgICAgICAgICBjb25zdCBjYWxsYmFjazogKHI6IGFueSkgPT4gdm9pZCA9IGNiLmNhbGxiYWNrXG4gICAgICAgICAgICAgIGNhbGxiYWNrKHJlc3VsdClcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGJyZWFrXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9LFxuICAgIClcbiAgICB0aGlzLl9lbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3dpbGwtbmF2aWdhdGUnLCBhc3luYyAoZSkgPT4ge1xuICAgICAgaWYgKGUudXJsLnN0YXJ0c1dpdGgoJ2ZpbGU6Ly8nKSkge1xuICAgICAgICBoYW5kbGVQcm9taXNlKGF0b20ud29ya3NwYWNlLm9wZW4oZmlsZVVyaVRvUGF0aChlLnVybCkpKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2hlbGwub3BlbkV4dGVybmFsKGUudXJsKVxuICAgICAgfVxuICAgIH0pXG5cbiAgICB0aGlzLmRpc3Bvc2FibGVzLmFkZChcbiAgICAgIGF0b20uc3R5bGVzLm9uRGlkQWRkU3R5bGVFbGVtZW50KCgpID0+IHtcbiAgICAgICAgdGhpcy51cGRhdGVTdHlsZXMoKVxuICAgICAgfSksXG4gICAgICBhdG9tLnN0eWxlcy5vbkRpZFJlbW92ZVN0eWxlRWxlbWVudCgoKSA9PiB7XG4gICAgICAgIHRoaXMudXBkYXRlU3R5bGVzKClcbiAgICAgIH0pLFxuICAgICAgYXRvbS5zdHlsZXMub25EaWRVcGRhdGVTdHlsZUVsZW1lbnQoKCkgPT4ge1xuICAgICAgICB0aGlzLnVwZGF0ZVN0eWxlcygpXG4gICAgICB9KSxcbiAgICApXG5cbiAgICBjb25zdCBvbmxvYWQgPSAoKSA9PiB7XG4gICAgICBpZiAodGhpcy5kZXN0cm95ZWQpIHJldHVyblxuICAgICAgdGhpcy5fZWxlbWVudC5zZXRab29tTGV2ZWwodGhpcy56b29tTGV2ZWwpXG4gICAgICB0aGlzLnVwZGF0ZVN0eWxlcygpXG4gICAgICBpbml0KClcbiAgICB9XG4gICAgdGhpcy5fZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdkb20tcmVhZHknLCBvbmxvYWQpXG4gIH1cblxuICBwdWJsaWMgZ2V0IGVsZW1lbnQoKTogSFRNTEVsZW1lbnQge1xuICAgIHJldHVybiB0aGlzLl9lbGVtZW50XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgcnVuSlM8VD4oanM6IHN0cmluZykge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTxUPigocmVzb2x2ZSkgPT5cbiAgICAgIHRoaXMuX2VsZW1lbnQuZXhlY3V0ZUphdmFTY3JpcHQoanMsIGZhbHNlLCByZXNvbHZlKSxcbiAgICApXG4gIH1cblxuICBwdWJsaWMgZGVzdHJveSgpIHtcbiAgICBpZiAodGhpcy5kZXN0cm95ZWQpIHJldHVyblxuICAgIHRoaXMuZGVzdHJveWVkID0gdHJ1ZVxuICAgIHRoaXMuZGlzcG9zYWJsZXMuZGlzcG9zZSgpXG4gICAgdGhpcy5fZWxlbWVudC5yZW1vdmUoKVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHVwZGF0ZShodG1sOiBzdHJpbmcsIHJlbmRlckxhVGVYOiBib29sZWFuKSB7XG4gICAgaWYgKHRoaXMuZGVzdHJveWVkKSByZXR1cm4gdW5kZWZpbmVkXG4gICAgcmV0dXJuIHRoaXMucnVuUmVxdWVzdCgndXBkYXRlLXByZXZpZXcnLCB7XG4gICAgICBodG1sLFxuICAgICAgcmVuZGVyTGFUZVgsXG4gICAgfSlcbiAgfVxuXG4gIHB1YmxpYyBzZXRTb3VyY2VNYXAobWFwOiB7XG4gICAgW2xpbmU6IG51bWJlcl06IHsgdGFnOiBzdHJpbmc7IGluZGV4OiBudW1iZXIgfVtdXG4gIH0pIHtcbiAgICB0aGlzLl9lbGVtZW50LnNlbmQ8J3NldC1zb3VyY2UtbWFwJz4oJ3NldC1zb3VyY2UtbWFwJywgeyBtYXAgfSlcbiAgfVxuXG4gIHB1YmxpYyBzZXRVc2VHaXRIdWJTdHlsZSh2YWx1ZTogYm9vbGVhbikge1xuICAgIHRoaXMuX2VsZW1lbnQuc2VuZDwndXNlLWdpdGh1Yi1zdHlsZSc+KCd1c2UtZ2l0aHViLXN0eWxlJywgeyB2YWx1ZSB9KVxuICB9XG5cbiAgcHVibGljIHNldEJhc2VQYXRoKHBhdGg/OiBzdHJpbmcpIHtcbiAgICB0aGlzLl9lbGVtZW50LnNlbmQ8J3NldC1iYXNlLXBhdGgnPignc2V0LWJhc2UtcGF0aCcsIHsgcGF0aCB9KVxuICB9XG5cbiAgcHVibGljIGluaXQoXG4gICAgYXRvbUhvbWU6IHN0cmluZyxcbiAgICBtYXRoSmF4Q29uZmlnOiBNYXRoSmF4Q29uZmlnLFxuICAgIG1hdGhKYXhSZW5kZXJlciA9IGF0b21Db25maWcoKS5tYXRoQ29uZmlnLmxhdGV4UmVuZGVyZXIsXG4gICkge1xuICAgIHRoaXMuX2VsZW1lbnQuc2VuZDwnaW5pdCc+KCdpbml0Jywge1xuICAgICAgYXRvbUhvbWUsXG4gICAgICBtYXRoSmF4Q29uZmlnLFxuICAgICAgbWF0aEpheFJlbmRlcmVyLFxuICAgIH0pXG4gIH1cblxuICBwdWJsaWMgdXBkYXRlSW1hZ2VzKG9sZFNvdXJjZTogc3RyaW5nLCB2ZXJzaW9uOiBudW1iZXIgfCB1bmRlZmluZWQpIHtcbiAgICB0aGlzLl9lbGVtZW50LnNlbmQ8J3VwZGF0ZS1pbWFnZXMnPigndXBkYXRlLWltYWdlcycsIHtcbiAgICAgIG9sZHNyYzogb2xkU291cmNlLFxuICAgICAgdjogdmVyc2lvbixcbiAgICB9KVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHNhdmVUb1BERihmaWxlUGF0aDogc3RyaW5nKSB7XG4gICAgY29uc3Qgb3B0cyA9IGF0b21Db25maWcoKS5zYXZlQ29uZmlnLnNhdmVUb1BERk9wdGlvbnNcbiAgICBjb25zdCBjdXN0b21QYWdlU2l6ZSA9IHBhcnNlUGFnZVNpemUob3B0cy5jdXN0b21QYWdlU2l6ZSlcbiAgICBjb25zdCBwYWdlU2l6ZSA9IG9wdHMucGFnZVNpemUgPT09ICdDdXN0b20nID8gY3VzdG9tUGFnZVNpemUgOiBvcHRzLnBhZ2VTaXplXG4gICAgaWYgKHBhZ2VTaXplID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEZhaWxlZCB0byBwYXJzZSBjdXN0b20gcGFnZSBzaXplOiAke29wdHMuY3VzdG9tUGFnZVNpemV9YCxcbiAgICAgIClcbiAgICB9XG4gICAgY29uc3Qgc2VsZWN0aW9uID0gYXdhaXQgdGhpcy5nZXRTZWxlY3Rpb24oKVxuICAgIGNvbnN0IHByaW50U2VsZWN0aW9uT25seSA9IHNlbGVjdGlvbiA/IG9wdHMucHJpbnRTZWxlY3Rpb25Pbmx5IDogZmFsc2VcbiAgICBjb25zdCBuZXdPcHRzID0ge1xuICAgICAgLi4ub3B0cyxcbiAgICAgIHBhZ2VTaXplLFxuICAgICAgcHJpbnRTZWxlY3Rpb25Pbmx5LFxuICAgIH1cbiAgICBhd2FpdCB0aGlzLnByZXBhcmVTYXZlVG9QREYobmV3T3B0cylcbiAgICB0cnkge1xuICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG5ldyBQcm9taXNlPEJ1ZmZlcj4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAvLyBUT0RPOiBDb21wbGFpbiBvbiBFbGVjdHJvblxuICAgICAgICB0aGlzLl9lbGVtZW50LnByaW50VG9QREYobmV3T3B0cyBhcyBhbnksIChlcnJvciwgZGF0YSkgPT4ge1xuICAgICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgICAgcmVqZWN0KGVycm9yKVxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgICAgfVxuICAgICAgICAgIHJlc29sdmUoZGF0YSlcbiAgICAgICAgfSlcbiAgICAgIH0pXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgIGZzLndyaXRlRmlsZShmaWxlUGF0aCwgZGF0YSwgKGVycm9yKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgICByZWplY3QoZXJyb3IpXG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgICB9XG4gICAgICAgICAgcmVzb2x2ZSgpXG4gICAgICAgIH0pXG4gICAgICB9KVxuICAgIH0gZmluYWxseSB7XG4gICAgICBoYW5kbGVQcm9taXNlKHRoaXMuZmluaXNoU2F2ZVRvUERGKCkpXG4gICAgfVxuICB9XG5cbiAgcHVibGljIHN5bmMobGluZTogbnVtYmVyLCBmbGFzaDogYm9vbGVhbikge1xuICAgIHRoaXMuX2VsZW1lbnQuc2VuZDwnc3luYyc+KCdzeW5jJywgeyBsaW5lLCBmbGFzaCB9KVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHN5bmNTb3VyY2UoKSB7XG4gICAgcmV0dXJuIHRoaXMucnVuUmVxdWVzdCgnc3luYy1zb3VyY2UnLCB7fSlcbiAgfVxuXG4gIHB1YmxpYyBzY3JvbGxTeW5jKGZpcnN0TGluZTogbnVtYmVyLCBsYXN0TGluZTogbnVtYmVyKSB7XG4gICAgdGhpcy5fZWxlbWVudC5zZW5kPCdzY3JvbGwtc3luYyc+KCdzY3JvbGwtc3luYycsIHsgZmlyc3RMaW5lLCBsYXN0TGluZSB9KVxuICB9XG5cbiAgcHVibGljIHpvb21JbigpIHtcbiAgICB0aGlzLnpvb21MZXZlbCArPSAwLjFcbiAgICB0aGlzLl9lbGVtZW50LnNldFpvb21MZXZlbCh0aGlzLnpvb21MZXZlbClcbiAgfVxuXG4gIHB1YmxpYyB6b29tT3V0KCkge1xuICAgIHRoaXMuem9vbUxldmVsIC09IDAuMVxuICAgIHRoaXMuX2VsZW1lbnQuc2V0Wm9vbUxldmVsKHRoaXMuem9vbUxldmVsKVxuICB9XG5cbiAgcHVibGljIHJlc2V0Wm9vbSgpIHtcbiAgICB0aGlzLnpvb21MZXZlbCA9IDBcbiAgICB0aGlzLl9lbGVtZW50LnNldFpvb21MZXZlbCh0aGlzLnpvb21MZXZlbClcbiAgfVxuXG4gIHB1YmxpYyBwcmludCgpIHtcbiAgICB0aGlzLl9lbGVtZW50LnByaW50KClcbiAgfVxuXG4gIHB1YmxpYyBvcGVuRGV2VG9vbHMoKSB7XG4gICAgdGhpcy5fZWxlbWVudC5vcGVuRGV2VG9vbHMoKVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHJlbG9hZCgpIHtcbiAgICBhd2FpdCB0aGlzLnJ1blJlcXVlc3QoJ3JlbG9hZCcsIHt9KVxuICAgIHRoaXMuX2VsZW1lbnQucmVsb2FkKClcbiAgfVxuXG4gIHB1YmxpYyBlcnJvcihtc2c6IHN0cmluZykge1xuICAgIHRoaXMuX2VsZW1lbnQuc2VuZDwnZXJyb3InPignZXJyb3InLCB7IG1zZyB9KVxuICB9XG5cbiAgcHVibGljIGFzeW5jIGdldFRlWENvbmZpZygpIHtcbiAgICByZXR1cm4gdGhpcy5ydW5SZXF1ZXN0KCdnZXQtdGV4LWNvbmZpZycsIHt9KVxuICB9XG5cbiAgcHVibGljIGFzeW5jIGdldFNlbGVjdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcy5ydW5SZXF1ZXN0KCdnZXQtc2VsZWN0aW9uJywge30pXG4gIH1cblxuICBwcm90ZWN0ZWQgYXN5bmMgcnVuUmVxdWVzdDxUIGV4dGVuZHMga2V5b2YgUmVxdWVzdFJlcGx5TWFwPihcbiAgICByZXF1ZXN0OiBULFxuICAgIGFyZ3M6IHsgW0sgaW4gRXhjbHVkZTxrZXlvZiBDaGFubmVsTWFwW1RdLCAnaWQnPl06IENoYW5uZWxNYXBbVF1bS10gfSxcbiAgKSB7XG4gICAgY29uc3QgaWQgPSB0aGlzLnJlcGx5Q2FsbGJhY2tJZCsrXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPFJlcXVlc3RSZXBseU1hcFtUXT4oKHJlc29sdmUpID0+IHtcbiAgICAgIHRoaXMucmVwbHlDYWxsYmFja3Muc2V0KGlkLCB7XG4gICAgICAgIHJlcXVlc3Q6IHJlcXVlc3QsXG4gICAgICAgIGNhbGxiYWNrOiAocmVzdWx0OiBSZXF1ZXN0UmVwbHlNYXBbVF0pID0+IHtcbiAgICAgICAgICB0aGlzLnJlcGx5Q2FsbGJhY2tzLmRlbGV0ZShpZClcbiAgICAgICAgICByZXNvbHZlKHJlc3VsdClcbiAgICAgICAgfSxcbiAgICAgIH0gYXMgUmVwbHlDYWxsYmFja1N0cnVjdDxUPilcbiAgICAgIGNvbnN0IG5ld2FyZ3MgPSBPYmplY3QuYXNzaWduKHsgaWQgfSwgYXJncylcbiAgICAgIHRoaXMuX2VsZW1lbnQuc2VuZDxUPihyZXF1ZXN0LCBuZXdhcmdzKVxuICAgIH0pXG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHByZXBhcmVTYXZlVG9QREYob3B0czoge1xuICAgIHBhZ2VTaXplOiBQYWdlU2l6ZVxuICAgIGxhbmRzY2FwZTogYm9vbGVhblxuICB9KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgW3dpZHRoLCBoZWlnaHRdID0gZ2V0UGFnZVdpZHRoKG9wdHMucGFnZVNpemUpXG4gICAgcmV0dXJuIHRoaXMucnVuUmVxdWVzdCgnc2V0LXdpZHRoJywge1xuICAgICAgd2lkdGg6IG9wdHMubGFuZHNjYXBlID8gaGVpZ2h0IDogd2lkdGgsXG4gICAgfSlcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgZmluaXNoU2F2ZVRvUERGKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiB0aGlzLnJ1blJlcXVlc3QoJ3NldC13aWR0aCcsIHsgd2lkdGg6IHVuZGVmaW5lZCB9KVxuICB9XG5cbiAgcHJpdmF0ZSB1cGRhdGVTdHlsZXMoKSB7XG4gICAgY29uc3Qgc3R5bGVzOiBzdHJpbmdbXSA9IFtdXG4gICAgZm9yIChjb25zdCBzZSBvZiBhdG9tLnN0eWxlcy5nZXRTdHlsZUVsZW1lbnRzKCkpIHtcbiAgICAgIHN0eWxlcy5wdXNoKHNlLmlubmVySFRNTClcbiAgICB9XG4gICAgdGhpcy5fZWxlbWVudC5zZW5kPCdzdHlsZSc+KCdzdHlsZScsIHsgc3R5bGVzIH0pXG4gIH1cbn1cblxudHlwZSBVbml0ID0gJ21tJyB8ICdjbScgfCAnaW4nXG5cbmZ1bmN0aW9uIHBhcnNlUGFnZVNpemUoc2l6ZTogc3RyaW5nKSB7XG4gIGlmICghc2l6ZSkgcmV0dXJuIHVuZGVmaW5lZFxuICBjb25zdCByeCA9IC9eKFtcXGQuLF0rKShjbXxtbXxpbik/eChbXFxkLixdKykoY218bW18aW4pPyQvaVxuICBjb25zdCByZXMgPSBzaXplLnJlcGxhY2UoL1xccyovZywgJycpLm1hdGNoKHJ4KVxuICBpZiAocmVzKSB7XG4gICAgY29uc3Qgd2lkdGggPSBwYXJzZUZsb2F0KHJlc1sxXSlcbiAgICBjb25zdCB3dW5pdCA9IHJlc1syXSBhcyBVbml0IHwgdW5kZWZpbmVkXG4gICAgY29uc3QgaGVpZ2h0ID0gcGFyc2VGbG9hdChyZXNbM10pXG4gICAgY29uc3QgaHVuaXQgPSByZXNbNF0gYXMgVW5pdCB8IHVuZGVmaW5lZFxuICAgIHJldHVybiB7XG4gICAgICB3aWR0aDogY29udmVydCh3aWR0aCwgd3VuaXQpLFxuICAgICAgaGVpZ2h0OiBjb252ZXJ0KGhlaWdodCwgaHVuaXQpLFxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkXG4gIH1cbn1cblxudHlwZSBQYWdlU2l6ZSA9XG4gIHwgRXhjbHVkZTxcbiAgICAgIENvbmZpZ1ZhbHVlc1snbWFya2Rvd24tcHJldmlldy1wbHVzLnNhdmVDb25maWcuc2F2ZVRvUERGT3B0aW9ucy5wYWdlU2l6ZSddLFxuICAgICAgJ0N1c3RvbSdcbiAgICA+XG4gIHwgeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9XG5cbmZ1bmN0aW9uIGNvbnZlcnQodmFsOiBudW1iZXIsIHVuaXQ/OiBVbml0KSB7XG4gIHJldHVybiB2YWwgKiB1bml0SW5NaWNyb25zKHVuaXQpXG59XG5cbmZ1bmN0aW9uIHVuaXRJbk1pY3JvbnModW5pdDogVW5pdCA9ICdtbScpIHtcbiAgc3dpdGNoICh1bml0KSB7XG4gICAgY2FzZSAnbW0nOlxuICAgICAgcmV0dXJuIDEwMDBcbiAgICBjYXNlICdjbSc6XG4gICAgICByZXR1cm4gMTAwMDBcbiAgICBjYXNlICdpbic6XG4gICAgICByZXR1cm4gMjU0MDBcbiAgfVxufVxuXG5mdW5jdGlvbiBnZXRQYWdlV2lkdGgocGFnZVNpemU6IFBhZ2VTaXplKSB7XG4gIHN3aXRjaCAocGFnZVNpemUpIHtcbiAgICBjYXNlICdBMyc6XG4gICAgICByZXR1cm4gWzI5NywgNDIwXVxuICAgIGNhc2UgJ0E0JzpcbiAgICAgIHJldHVybiBbMjEwLCAyOTddXG4gICAgY2FzZSAnQTUnOlxuICAgICAgcmV0dXJuIFsxNDgsIDIxMF1cbiAgICBjYXNlICdMZWdhbCc6XG4gICAgICByZXR1cm4gWzIxNiwgMzU2XVxuICAgIGNhc2UgJ0xldHRlcic6XG4gICAgICByZXR1cm4gWzIxNiwgMjc5XVxuICAgIGNhc2UgJ1RhYmxvaWQnOlxuICAgICAgcmV0dXJuIFsyNzksIDQzMl1cbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIFtwYWdlU2l6ZS53aWR0aCAvIDEwMDAsIHBhZ2VTaXplLmhlaWdodCAvIDEwMDBdXG4gIH1cbn1cbiJdfQ==