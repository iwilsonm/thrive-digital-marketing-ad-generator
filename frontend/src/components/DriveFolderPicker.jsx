import { useState, useEffect } from 'react';
import { api } from '../api';

export default function DriveFolderPicker({ value, onChange, label }) {
  const [open, setOpen] = useState(false);
  const [driveOk, setDriveOk] = useState(null); // null = loading, true/false
  const [serviceEmail, setServiceEmail] = useState('');
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [atRoot, setAtRoot] = useState(true);
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [selectedId, setSelectedId] = useState(value || '');
  const [selectedName, setSelectedName] = useState('');
  const [error, setError] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    if (open) {
      api.driveStatus().then(data => {
        setDriveOk(data.configured);
        setServiceEmail(data.serviceAccountEmail || '');
        if (data.configured) loadFolders(null);
      }).catch(() => setDriveOk(false));
    }
  }, [open]);

  useEffect(() => {
    if (value && !selectedName) {
      api.driveFolderInfo(value).then(data => {
        setSelectedName(data.folder.name);
      }).catch(() => {});
    }
  }, [value]);

  const loadFolders = async (parentId) => {
    setLoading(true);
    setError('');
    setAtRoot(!parentId);
    try {
      const data = await api.driveFolders(parentId);
      setFolders(data.folders);

      if (parentId) {
        const info = await api.driveFolderInfo(parentId);
        setBreadcrumb(info.breadcrumb);
      } else {
        setBreadcrumb([]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (folder) => {
    setSelectedId(folder.id);
    setSelectedName(folder.name);
  };

  const handleConfirm = () => {
    onChange(selectedId);
    setOpen(false);
  };

  const handleNavigate = (folder) => {
    loadFolders(folder.id);
  };

  return (
    <div>
      <label className="block text-sm font-medium text-ed-ink2 mb-1">{label}</label>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          className="flex-1 input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent"
          placeholder="Google Drive folder ID"
        />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="ed-ghost whitespace-nowrap"
        >
          Browse
        </button>
      </div>
      {selectedName && value && (
        <p className="text-xs text-ed-ink2 mt-1">📁 {selectedName}</p>
      )}

      {/* Folder browser modal */}
      {open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-ed-surface rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col border border-black/5">
            <div className="p-4 border-b border-black/5 flex items-center justify-between">
              <h3 className="font-semibold text-ed-ink">{label}</h3>
              <button onClick={() => setOpen(false)} className="text-ed-ink3 hover:text-ed-ink2 text-xl">&times;</button>
            </div>

            {driveOk === false && (
              <div className="p-6 text-center">
                <p className="text-ed-ink2 mb-2">Google Drive not configured.</p>
                <p className="text-xs text-ed-ink3">
                  Place your <code className="bg-black/5 px-1 rounded">service-account.json</code> in the <code className="bg-black/5 px-1 rounded">config/</code> directory, then share your Drive folders with the service account email.
                </p>
              </div>
            )}

            {driveOk && (
              <>
                {/* Breadcrumb */}
                <div className="px-4 pt-3 flex flex-wrap items-center gap-1 text-xs text-ed-ink2">
                  <button
                    onClick={() => loadFolders(null)}
                    className="hover:text-ed-accent font-medium"
                  >
                    Root
                  </button>
                  {breadcrumb.map((item, i) => (
                    <span key={item.id} className="flex items-center gap-1">
                      <span>/</span>
                      <button
                        onClick={() => loadFolders(item.id)}
                        className="hover:text-ed-accent"
                      >
                        {item.name}
                      </button>
                    </span>
                  ))}
                </div>

                {error && (
                  <div className="mx-4 mt-2 bg-red-50 text-red-700 text-xs rounded-xl p-2">{error}</div>
                )}

                {/* Folder list */}
                <div className="flex-1 overflow-y-auto p-4">
                  {loading ? (
                    <p className="text-ed-ink3 text-sm text-center py-4">Loading...</p>
                  ) : folders.length === 0 ? (
                    <p className="text-ed-ink3 text-sm text-center py-4">
                      {atRoot ? 'No folders shared with this service account yet.' : 'This folder is empty.'}
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {folders.map(folder => (
                        <div
                          key={folder.id}
                          className={`flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer ${
                            selectedId === folder.id ? 'bg-ed-accent/5 border border-ed-accent/20' : 'hover:bg-black/3'
                          }`}
                          onClick={() => handleSelect(folder)}
                          onDoubleClick={() => handleNavigate(folder)}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-ed-accent">📁</span>
                            <span className="text-sm text-ed-ink">{folder.name}</span>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleNavigate(folder); }}
                            className="text-xs text-ed-ink3 hover:text-ed-accent"
                          >
                            Open →
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Share a new folder — always visible at root */}
                {atRoot && serviceEmail && (
                  <div className="px-4 pb-3">
                    <button
                      type="button"
                      onClick={() => setShowHelp(!showHelp)}
                      className="flex items-center gap-1 text-xs text-ed-accent hover:text-ed-accent/80"
                    >
                      <span>{showHelp ? '▾' : '▸'}</span>
                      Don't see your folder? Share it with the service account
                    </button>
                    {showHelp && (
                      <div className="mt-2 bg-cream border border-ed-accent/15 rounded-xl p-3">
                        <ol className="text-xs text-ed-accent space-y-1 list-decimal list-inside">
                          <li>Open Google Drive in your browser</li>
                          <li>Right-click the folder you want to use</li>
                          <li>Click <strong>Share</strong></li>
                          <li>Add this email as an <strong>Editor</strong>:</li>
                        </ol>
                        <div className="mt-2 bg-white rounded-lg px-2 py-1.5 text-xs font-mono text-ed-accent select-all break-all border border-ed-accent/15">
                          {serviceEmail}
                        </div>
                        <button
                          onClick={() => loadFolders(null)}
                          className="mt-2 text-xs text-ed-accent hover:underline"
                        >
                          Refresh folder list
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Footer */}
                <div className="p-4 border-t border-black/5 flex items-center justify-between">
                  <p className="text-xs text-ed-ink2">
                    {selectedName ? `Selected: ${selectedName}` : 'Click a folder to select, double-click to open'}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setOpen(false)}
                      className="ed-ghost text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleConfirm}
                      disabled={!selectedId}
                      className="bg-ed-accent text-white px-3 py-1.5 rounded-xl text-sm font-medium hover:bg-ed-accent/90 disabled:opacity-50 transition-colors"
                    >
                      Select Folder
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
