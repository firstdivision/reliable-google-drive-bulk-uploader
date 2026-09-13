interface PickerResult { action?: string; docs?: { id?: string }[] }
interface PickerView {
  setIncludeFolders(value: boolean): PickerView;
  setSelectFolderEnabled(value: boolean): PickerView;
  setMimeTypes(value: string): PickerView;
  setMode(value: string): PickerView;
  setOwnedByMe(value: boolean): PickerView;
  setLabel(value: string): PickerView;
}
interface PickerDialog { setVisible(value: boolean): void; dispose(): void }
interface PickerBuilder {
  setDeveloperKey(value: string): PickerBuilder;
  setAppId(value: string): PickerBuilder;
  setOAuthToken(value: string): PickerBuilder;
  setOrigin(value: string): PickerBuilder;
  setTitle(value: string): PickerBuilder;
  addView(view: PickerView): PickerBuilder;
  setCallback(callback: (result: PickerResult) => void): PickerBuilder;
  build(): PickerDialog;
}
interface PickerApi {
  DocsView: new (id: string) => PickerView;
  PickerBuilder: new () => PickerBuilder;
  ViewId: { DOCS: string };
  DocsViewMode: { LIST: string };
  Action: { PICKED: string; CANCEL: string };
}
interface GoogleWindow extends Window {
  gapi?: { load(name: string, options: { callback(): void; onerror(): void; timeout: number; ontimeout(): void }): void };
  google?: { picker?: PickerApi };
}

let loading: Promise<PickerApi> | undefined;

function loadPicker(): Promise<PickerApi> {
  const host = window as GoogleWindow;
  if (host.google?.picker) return Promise.resolve(host.google.picker);
  if (loading) return loading;
  loading = new Promise<PickerApi>((resolve, reject) => {
    let settled = false;
    const script = document.createElement('script');
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (error) { script.remove(); reject(error); }
      else if (host.google?.picker) resolve(host.google.picker);
      else reject(new Error('Google Drive browser did not load. Try again.'));
    };
    const fail = () => finish(new Error('Google Drive browser could not load. Check your connection and try again.'));
    const timer = setTimeout(fail, 15000);
    const initialize = () => {
      if (settled) return;
      try {
        if (!host.gapi) { fail(); return; }
        host.gapi.load('picker', { callback: () => finish(), onerror: fail, timeout: 15000, ontimeout: fail });
      } catch { fail(); }
    };
    if (host.gapi) initialize();
    else {
      script.src = 'https://apis.google.com/js/api.js';
      script.async = true;
      script.onload = initialize;
      script.onerror = fail;
      document.head.append(script);
    }
  }).catch(error => { loading = undefined; throw error; });
  return loading;
}

export interface FolderPicker {
  pick(getToken: () => string): Promise<string | null>;
  cancel(): void;
}

export class GoogleFolderPicker implements FolderPicker {
  private pending = false;
  private cancelPending?: () => void;

  constructor(private readonly config: { apiKey: string; appId: string },
    private readonly load: () => Promise<PickerApi> = loadPicker,
    private readonly origin: () => string = () => window.location.origin) {}

  async pick(getToken: () => string): Promise<string | null> {
    if (this.pending) throw new Error('A Google Drive browser is already open.');
    if (!this.config.apiKey || !/^\d+$/.test(this.config.appId)) {
      throw new Error('Drive browsing is not configured on this site. The site owner must configure the Google Picker API key and project number.');
    }
    this.pending = true;
    let cancelled = false;
    let cancel!: () => void;
    const cancellation = new Promise<null>(resolve => { cancel = () => { cancelled = true; resolve(null); }; });
    this.cancelPending = cancel;
    let dialog: PickerDialog | undefined;
    try {
      const picker = await Promise.race([this.load(), cancellation]);
      if (!picker || cancelled) return null;
      const token = getToken();
      return await new Promise<string | null>((resolve, reject) => {
        let settled = false;
        const finish = (id: string | null, error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error); else resolve(id);
        };
        this.cancelPending = () => finish(null);
        const folderView = (ownedByMe: boolean) => new picker.DocsView(picker.ViewId.DOCS)
          .setIncludeFolders(true).setSelectFolderEnabled(true)
          .setMimeTypes('application/vnd.google-apps.folder')
          .setMode(picker.DocsViewMode.LIST).setOwnedByMe(ownedByMe);
        dialog = new picker.PickerBuilder().setDeveloperKey(this.config.apiKey)
          .setAppId(this.config.appId).setOAuthToken(token).setOrigin(this.origin())
          .setTitle('Choose your upload folder')
          .addView(folderView(true).setLabel('My folders'))
          .addView(folderView(false).setLabel('Shared with me'))
          .setCallback(result => {
            if (result.action === picker.Action.CANCEL) finish(null);
            if (result.action === picker.Action.PICKED) {
              const id = result.docs?.[0]?.id;
              if (result.docs?.length !== 1 || typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
                finish(null, new Error('Choose one Google Drive folder.'));
              } else finish(id);
            }
            if (result.action === 'error') finish(null, new Error('Google Drive browsing failed. Check access and try again.'));
          }).build();
        dialog.setVisible(true);
      });
    } finally {
      try { dialog?.dispose(); }
      finally { this.cancelPending = undefined; this.pending = false; }
    }
  }

  cancel(): void { this.cancelPending?.(); }
}