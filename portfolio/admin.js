// ========================================
// SametStore Admin Panel - JavaScript
// ========================================

let assetsData = null;
let originalData = null;
let deleteAssetId = null;

// ========================================
// Default Assets Data (Fallback for file:// protocol)
// ========================================
const DEFAULT_ASSETS_DATA = {
    "assets": [
        {
            "id": "phone-system",
            "name": "Advanced Phone System V3 Replicated",
            "description": "Complete multiplayer phone system with messaging, calls, contacts, and more. Fully replicated for multiplayer games.",
            "price": 50, "currency": "USD",
            "link": "https://www.fab.com/listings/e627507f-3dbd-4b88-8e3e-db4dc1730fdd",
            "tags": ["Multiplayer", "UI System", "Blueprint"], "featured": true,
            "images": ["../DataList/Phone/c8a11308-048c-416a-b73b-2a42dd3331a8.jpg", "../DataList/Phone/0bbe84ab-75a0-4ed8-b0f9-36e4c1e32bce.jpg", "../DataList/Phone/601477a1-1579-472a-a46d-b09f929ac68d.jpg", "../DataList/Phone/847f52af-a04d-4527-b01b-3be7e54be67b.jpg"]
        },
        {
            "id": "market-system",
            "name": "Advanced Market System",
            "description": "Full-featured marketplace system with inventory, trading, and economy management. Perfect for RPGs and MMOs.",
            "price": 50, "currency": "USD",
            "link": "https://www.fab.com/listings/4a319804-03da-4d35-9d73-85d5871dd2ea",
            "tags": ["Economy", "Inventory", "Multiplayer"], "featured": true,
            "images": ["../DataList/Market/3addfac8-6c36-4e59-8a7f-f3b68d274286.jpg", "../DataList/Market/2d6d11c9-ff57-4b16-a06f-4ccd089c0f87.jpg", "../DataList/Market/2d924be4-960f-4b36-a32a-69e16bb53a59.jpg", "../DataList/Market/a2d0e70a-7b1a-4ab8-ad8a-3eaa29463e12.jpg"]
        },
        {
            "id": "dialogue-system",
            "name": "NBDS - Node Based Dialogue System",
            "description": "Powerful node-based dialogue editor with multiplayer support. Create complex branching conversations easily.",
            "price": 30, "currency": "USD",
            "link": "https://www.fab.com/listings/204eb999-fa5d-4675-9b37-c1f628d79f2b",
            "tags": ["Dialogue", "Node Editor", "Multiplayer"], "featured": false,
            "images": ["../DataList/Dialogue/132c3891-429f-49c1-9f9b-806030c82f5a.jpg", "../DataList/Dialogue/05c8001f-5ecd-4a2a-8206-fab224ad5085.jpg", "../DataList/Dialogue/43f4027a-44aa-4256-9e13-63a7f06c2224.jpg", "../DataList/Dialogue/471cd2e2-070c-4773-8576-a2880cd4f2a3.jpg"]
        },
        {
            "id": "flying-carpet",
            "name": "Multiplayer Flying Carpet/Broom",
            "description": "Magical flying system with Follow AI. Perfect for fantasy games with Harry Potter-style flying mechanics.",
            "price": 30, "currency": "USD",
            "link": "https://www.fab.com/listings/7b171ff8-616a-4a10-9768-8400fbe93aea",
            "tags": ["Movement", "AI", "Multiplayer"], "featured": false,
            "images": ["../DataList/flying_Carpet/d35cad64-f06b-413e-ae1a-6b37db795a99.jpg", "../DataList/flying_Carpet/133bea81-c4a2-48bd-821d-3db1cad1563b.jpg", "../DataList/flying_Carpet/6fa8d53d-a217-4464-a90f-e86fe4c20030.jpg", "../DataList/flying_Carpet/b26fe9f0-1f79-4dac-a23a-adb07a7eed04.jpg"]
        },
        {
            "id": "rc-car",
            "name": "RC Car System V1",
            "description": "Remote controlled car system with realistic physics. Great for mini-games and vehicle mechanics.",
            "price": 10, "currency": "USD",
            "link": "https://www.fab.com/listings/8dce82ac-ed9d-471f-9f8e-5fbe89e81b2d",
            "tags": ["Vehicle", "Physics", "Gameplay"], "featured": false,
            "images": ["../DataList/carsystem.jpg"]
        },
        {
            "id": "combination-lock",
            "name": "Multiplayer Combination Lock",
            "description": "Interactive combination lock system with multiplayer sync. Perfect for escape rooms and puzzle games.",
            "price": 10, "currency": "USD",
            "link": "https://www.fab.com/listings/9f9a7d3d-b913-480d-ad1d-e875e12ee836",
            "tags": ["Puzzle", "Interactive", "Multiplayer"], "featured": false,
            "images": ["../DataList/lock/1219cec9-5683-43fb-9695-251cfa09b352.jpg", "../DataList/lock/023bff4c-257e-42f4-8bc5-2e46eb805e65.jpg", "../DataList/lock/dae56253-1a6c-493f-ad02-93266fb29ed2.jpg"]
        },
        {
            "id": "video-chat",
            "name": "Multiplayer Video Chat",
            "description": "In-game video chat system for multiplayer games. Enable players to communicate face-to-face.",
            "price": 7, "currency": "USD",
            "link": "https://www.fab.com/listings/a07aa037-ba61-4b02-81b4-028a21232281",
            "tags": ["Communication", "Video", "Multiplayer"], "featured": false,
            "images": ["../DataList/videochat.jpg"]
        },
        {
            "id": "editor-save",
            "name": "Editor Save System",
            "description": "Save and load system for Unreal Editor. Preserve your work and settings effortlessly.",
            "price": 3, "currency": "USD",
            "link": "https://www.fab.com/listings/1f370f2b-2bd7-4aa7-a9fb-343be515371e",
            "tags": ["Editor", "Utility", "Save/Load"], "featured": false,
            "images": ["../DataList/editorsave.jpg"]
        }
    ],
    "siteInfo": {
        "storeName": "SametStore",
        "tagline": "Premium Unreal Engine Assets",
        "fabStoreUrl": "https://www.fab.com/sellers/SametStore",
        "aboutText": "SametStore is a dedicated Unreal Engine asset developer focused on creating high-quality, production-ready multiplayer systems and game mechanics.",
        "aboutText2": "Every asset we create is built with multiplayer in mind, ensuring seamless replication and synchronization across all clients."
    }
};

// ========================================
// Initialize
// ========================================
document.addEventListener('DOMContentLoaded', function () {
    loadData();
    createToastContainer();
});

// ========================================
// Load Data
// ========================================
async function loadData() {
    try {
        // First try localStorage
        const savedData = localStorage.getItem('sametstore_assets');
        if (savedData) {
            assetsData = JSON.parse(savedData);
        } else {
            // Try to load from JSON file, fallback to embedded data
            try {
                const response = await fetch('assets.json');
                if (response.ok) {
                    assetsData = await response.json();
                } else {
                    throw new Error('Fetch failed');
                }
            } catch (fetchError) {
                console.log('Using embedded default data (file:// protocol detected)');
                assetsData = JSON.parse(JSON.stringify(DEFAULT_ASSETS_DATA));
            }
        }

        // Set original data for reset functionality
        originalData = JSON.parse(JSON.stringify(DEFAULT_ASSETS_DATA));

        renderAssetsList();
        populateSiteInfo();

    } catch (error) {
        console.error('Error loading data:', error);
        // Last resort: use default data
        assetsData = JSON.parse(JSON.stringify(DEFAULT_ASSETS_DATA));
        originalData = JSON.parse(JSON.stringify(DEFAULT_ASSETS_DATA));
        renderAssetsList();
        populateSiteInfo();
    }
}

// ========================================
// Render Assets List
// ========================================
function renderAssetsList() {
    const container = document.getElementById('assets-list');
    const countEl = document.getElementById('asset-count');

    if (!assetsData || !assetsData.assets || assetsData.assets.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                </svg>
                <h3>No assets yet</h3>
                <p>Click "Add New Asset" to create your first asset</p>
            </div>
        `;
        countEl.textContent = '0';
        return;
    }

    countEl.textContent = assetsData.assets.length;

    container.innerHTML = assetsData.assets.map(asset => `
        <div class="asset-item" data-id="${asset.id}">
            <div class="asset-item-image">
                ${asset.images && asset.images.length > 0
            ? `<img src="${asset.images[0]}" alt="${asset.name}">`
            : '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">No Image</div>'
        }
            </div>
            <div class="asset-item-info">
                <div class="asset-item-name">${asset.name}</div>
                <div class="asset-item-meta">
                    <span class="asset-item-price">$${asset.price} ${asset.currency}</span>
                    <span>${asset.images ? asset.images.length : 0} images</span>
                    ${asset.featured ? '<span class="asset-item-featured">⭐ Featured</span>' : ''}
                </div>
            </div>
            <div class="asset-item-actions">
                <button class="btn-icon edit" onclick="editAsset('${asset.id}')" title="Edit">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
                <button class="btn-icon delete" onclick="openDeleteModal('${asset.id}')" title="Delete">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');
}

// ========================================
// Populate Site Info
// ========================================
function populateSiteInfo() {
    if (!assetsData || !assetsData.siteInfo) return;

    const info = assetsData.siteInfo;
    document.getElementById('storeName').value = info.storeName || '';
    document.getElementById('tagline').value = info.tagline || '';
    document.getElementById('fabStoreUrl').value = info.fabStoreUrl || '';
    document.getElementById('aboutText1').value = info.aboutText || '';
    document.getElementById('aboutText2').value = info.aboutText2 || '';
}

// ========================================
// Save Site Info
// ========================================
function saveSiteInfo() {
    assetsData.siteInfo = {
        storeName: document.getElementById('storeName').value,
        tagline: document.getElementById('tagline').value,
        fabStoreUrl: document.getElementById('fabStoreUrl').value,
        aboutText: document.getElementById('aboutText1').value,
        aboutText2: document.getElementById('aboutText2').value
    };

    saveToLocalStorage();
    showToast('Site info saved successfully!', 'success');
}

// ========================================
// Add/Edit Asset Modal
// ========================================
function openAddModal() {
    document.getElementById('form-modal-title').textContent = 'Add New Asset';
    document.getElementById('edit-mode').value = 'false';
    document.getElementById('asset-form').reset();
    document.getElementById('asset-id').value = '';

    // Reset image inputs
    document.getElementById('image-inputs').innerHTML = `
        <div class="image-input-row">
            <input type="text" class="image-url" placeholder="Image path or URL">
            <button type="button" class="btn-icon" onclick="removeImageInput(this)">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
            </button>
        </div>
    `;

    document.getElementById('asset-form-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function editAsset(assetId) {
    const asset = assetsData.assets.find(a => a.id === assetId);
    if (!asset) return;

    document.getElementById('form-modal-title').textContent = 'Edit Asset';
    document.getElementById('edit-mode').value = 'true';
    document.getElementById('asset-id').value = asset.id;
    document.getElementById('asset-name').value = asset.name;
    document.getElementById('asset-price').value = asset.price;
    document.getElementById('asset-featured').value = asset.featured ? 'true' : 'false';
    document.getElementById('asset-link').value = asset.link;
    document.getElementById('asset-description').value = asset.description;
    document.getElementById('asset-tags').value = asset.tags ? asset.tags.join(', ') : '';

    // Populate image inputs
    const imageInputsContainer = document.getElementById('image-inputs');
    if (asset.images && asset.images.length > 0) {
        imageInputsContainer.innerHTML = asset.images.map(img => `
            <div class="image-input-row">
                <input type="text" class="image-url" value="${img}" placeholder="Image path or URL">
                <button type="button" class="btn-icon" onclick="removeImageInput(this)">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </button>
            </div>
        `).join('');
    } else {
        imageInputsContainer.innerHTML = `
            <div class="image-input-row">
                <input type="text" class="image-url" placeholder="Image path or URL">
                <button type="button" class="btn-icon" onclick="removeImageInput(this)">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </button>
            </div>
        `;
    }

    document.getElementById('asset-form-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeFormModal() {
    document.getElementById('asset-form-modal').classList.remove('active');
    document.body.style.overflow = '';
}

function addImageInput() {
    const container = document.getElementById('image-inputs');
    const row = document.createElement('div');
    row.className = 'image-input-row';
    row.innerHTML = `
        <input type="text" class="image-url" placeholder="Image path or URL">
        <button type="button" class="btn-icon" onclick="removeImageInput(this)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
        </button>
    `;
    container.appendChild(row);
}

function removeImageInput(btn) {
    const row = btn.closest('.image-input-row');
    const container = document.getElementById('image-inputs');

    // Keep at least one input
    if (container.children.length > 1) {
        row.remove();
    } else {
        row.querySelector('input').value = '';
    }
}

// ========================================
// Save Asset
// ========================================
function saveAsset(event) {
    event.preventDefault();

    const isEdit = document.getElementById('edit-mode').value === 'true';
    const assetId = document.getElementById('asset-id').value;

    // Collect image URLs
    const imageInputs = document.querySelectorAll('#image-inputs .image-url');
    const images = Array.from(imageInputs)
        .map(input => input.value.trim())
        .filter(url => url !== '');

    // Collect tags
    const tagsValue = document.getElementById('asset-tags').value;
    const tags = tagsValue ? tagsValue.split(',').map(t => t.trim()).filter(t => t !== '') : [];

    const assetData = {
        id: isEdit ? assetId : generateId(document.getElementById('asset-name').value),
        name: document.getElementById('asset-name').value,
        price: parseFloat(document.getElementById('asset-price').value),
        currency: 'USD',
        featured: document.getElementById('asset-featured').value === 'true',
        link: document.getElementById('asset-link').value,
        description: document.getElementById('asset-description').value,
        tags: tags,
        images: images
    };

    if (isEdit) {
        // Update existing asset
        const index = assetsData.assets.findIndex(a => a.id === assetId);
        if (index !== -1) {
            assetsData.assets[index] = assetData;
        }
    } else {
        // Add new asset
        assetsData.assets.push(assetData);
    }

    saveToLocalStorage();
    renderAssetsList();
    closeFormModal();
    showToast(isEdit ? 'Asset updated successfully!' : 'Asset added successfully!', 'success');
}

function generateId(name) {
    return name.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        + '-' + Date.now().toString(36);
}

// ========================================
// Delete Asset
// ========================================
function openDeleteModal(assetId) {
    const asset = assetsData.assets.find(a => a.id === assetId);
    if (!asset) return;

    deleteAssetId = assetId;
    document.getElementById('delete-asset-name').textContent = asset.name;
    document.getElementById('delete-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeDeleteModal() {
    document.getElementById('delete-modal').classList.remove('active');
    document.body.style.overflow = '';
    deleteAssetId = null;
}

function confirmDelete() {
    if (!deleteAssetId) return;

    assetsData.assets = assetsData.assets.filter(a => a.id !== deleteAssetId);
    saveToLocalStorage();
    renderAssetsList();
    closeDeleteModal();
    showToast('Asset deleted successfully!', 'success');
}

// ========================================
// Reset to Default
// ========================================
function resetToDefault() {
    if (confirm('Are you sure you want to reset all data to default? This will remove all your changes.')) {
        localStorage.removeItem('sametstore_assets');
        assetsData = JSON.parse(JSON.stringify(originalData));
        renderAssetsList();
        populateSiteInfo();
        showToast('Data reset to default!', 'success');
    }
}

// ========================================
// Save to LocalStorage
// ========================================
function saveToLocalStorage() {
    localStorage.setItem('sametstore_assets', JSON.stringify(assetsData));
}

// ========================================
// Toast Notifications
// ========================================
function createToastContainer() {
    const container = document.createElement('div');
    container.className = 'toast-container';
    container.id = 'toast-container';
    document.body.appendChild(container);
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${type === 'success' ? '✓' : '✕'}</span>
        <span class="toast-message">${message}</span>
    `;
    container.appendChild(toast);

    // Remove after 3 seconds
    setTimeout(() => {
        toast.style.animation = 'slideInRight 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ========================================
// Keyboard Shortcuts
// ========================================
document.addEventListener('keydown', (e) => {
    // Escape to close modals
    if (e.key === 'Escape') {
        if (document.getElementById('asset-form-modal').classList.contains('active')) {
            closeFormModal();
        }
        if (document.getElementById('delete-modal').classList.contains('active')) {
            closeDeleteModal();
        }
    }

    // Ctrl+N for new asset
    if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        openAddModal();
    }
});

console.log('%c🔧 SametStore Admin Panel', 'font-size: 18px; font-weight: bold; color: #10b981;');
console.log('%cShortcuts: Ctrl+N = New Asset, Esc = Close Modal', 'font-size: 12px; color: #14b8a6;');
