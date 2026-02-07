// ========================================
// SametStore Portfolio - JavaScript
// Dynamic Asset Loading & Modal Gallery
// ========================================

let assetsData = null;
let currentModalAsset = null;
let currentImageIndex = 0;

document.addEventListener('DOMContentLoaded', function () {
    // Load assets data
    loadAssetsData();

    // Initialize components
    initNavbar();
    initMobileMenu();
    initModal();

    // Listen for localStorage changes from admin panel (other tabs)
    window.addEventListener('storage', function (e) {
        if (e.key === 'sametstore_assets') {
            console.log('Data updated from admin panel, refreshing...');
            loadAssetsData();
        }
    });
});

// ========================================
// Default Assets Data (Fallback for file:// protocol)
// ========================================
const DEFAULT_ASSETS_DATA = {
    "assets": [
        {
            "id": "phone-system",
            "name": "Advanced Phone System V3 Replicated",
            "description": "Complete multiplayer phone system with messaging, calls, contacts, and more. Fully replicated for multiplayer games. Features include SMS messaging, call functionality, contact management, notification system, and customizable UI. Perfect for GTA-style games or any project requiring in-game communication.",
            "price": 50,
            "currency": "USD",
            "link": "https://www.fab.com/listings/e627507f-3dbd-4b88-8e3e-db4dc1730fdd",
            "tags": ["Multiplayer", "UI System", "Blueprint"],
            "featured": true,
            "images": [
                "../DataList/Phone/c8a11308-048c-416a-b73b-2a42dd3331a8.jpg",
                "../DataList/Phone/0bbe84ab-75a0-4ed8-b0f9-36e4c1e32bce.jpg",
                "../DataList/Phone/601477a1-1579-472a-a46d-b09f929ac68d.jpg",
                "../DataList/Phone/847f52af-a04d-4527-b01b-3be7e54be67b.jpg"
            ]
        },
        {
            "id": "market-system",
            "name": "Advanced Market System",
            "description": "Full-featured marketplace system with inventory, trading, and economy management. Perfect for RPGs and MMOs. Includes buy/sell functionality, dynamic pricing, inventory management, item categories, search and filter options, and fully networked for multiplayer games.",
            "price": 50,
            "currency": "USD",
            "link": "https://www.fab.com/listings/4a319804-03da-4d35-9d73-85d5871dd2ea",
            "tags": ["Economy", "Inventory", "Multiplayer"],
            "featured": true,
            "images": [
                "../DataList/Market/3addfac8-6c36-4e59-8a7f-f3b68d274286.jpg",
                "../DataList/Market/2d6d11c9-ff57-4b16-a06f-4ccd089c0f87.jpg",
                "../DataList/Market/2d924be4-960f-4b36-a32a-69e16bb53a59.jpg",
                "../DataList/Market/a2d0e70a-7b1a-4ab8-ad8a-3eaa29463e12.jpg"
            ]
        },
        {
            "id": "dialogue-system",
            "name": "NBDS - Node Based Dialogue System",
            "description": "Powerful node-based dialogue editor with multiplayer support. Create complex branching conversations easily. Features include visual node editor, conditional branching, variable system, localization support, and seamless multiplayer integration. Great for RPGs, adventure games, and interactive narratives.",
            "price": 30,
            "currency": "USD",
            "link": "https://www.fab.com/listings/204eb999-fa5d-4675-9b37-c1f628d79f2b",
            "tags": ["Dialogue", "Node Editor", "Multiplayer"],
            "featured": false,
            "images": [
                "../DataList/Dialogue/132c3891-429f-49c1-9f9b-806030c82f5a.jpg",
                "../DataList/Dialogue/05c8001f-5ecd-4a2a-8206-fab224ad5085.jpg",
                "../DataList/Dialogue/43f4027a-44aa-4256-9e13-63a7f06c2224.jpg",
                "../DataList/Dialogue/471cd2e2-070c-4773-8576-a2880cd4f2a3.jpg"
            ]
        },
        {
            "id": "flying-carpet",
            "name": "Multiplayer Flying Carpet/Broom",
            "description": "Magical flying system with Follow AI. Perfect for fantasy games with Harry Potter-style flying mechanics. Includes smooth flight controls, multiplayer replication, AI companion that follows the player, customizable speed and handling, and beautiful visual effects.",
            "price": 30,
            "currency": "USD",
            "link": "https://www.fab.com/listings/7b171ff8-616a-4a10-9768-8400fbe93aea",
            "tags": ["Movement", "AI", "Multiplayer"],
            "featured": false,
            "images": [
                "../DataList/flying_Carpet/d35cad64-f06b-413e-ae1a-6b37db795a99.jpg",
                "../DataList/flying_Carpet/133bea81-c4a2-48bd-821d-3db1cad1563b.jpg",
                "../DataList/flying_Carpet/6fa8d53d-a217-4464-a90f-e86fe4c20030.jpg",
                "../DataList/flying_Carpet/b26fe9f0-1f79-4dac-a23a-adb07a7eed04.jpg"
            ]
        },
        {
            "id": "rc-car",
            "name": "RC Car System V1",
            "description": "Remote controlled car system with realistic physics. Great for mini-games and vehicle mechanics. Features include realistic RC car physics, camera switching, range limitations, battery system, and customizable car properties.",
            "price": 10,
            "currency": "USD",
            "link": "https://www.fab.com/listings/8dce82ac-ed9d-471f-9f8e-5fbe89e81b2d",
            "tags": ["Vehicle", "Physics", "Gameplay"],
            "featured": false,
            "images": [
                "../DataList/carsystem.jpg"
            ]
        },
        {
            "id": "combination-lock",
            "name": "Multiplayer Combination Lock",
            "description": "Interactive combination lock system with multiplayer sync. Perfect for escape rooms and puzzle games. Includes customizable digit count, visual and audio feedback, replicated state for multiplayer, easy integration, and Blueprint-friendly API.",
            "price": 10,
            "currency": "USD",
            "link": "https://www.fab.com/listings/9f9a7d3d-b913-480d-ad1d-e875e12ee836",
            "tags": ["Puzzle", "Interactive", "Multiplayer"],
            "featured": false,
            "images": [
                "../DataList/lock/1219cec9-5683-43fb-9695-251cfa09b352.jpg",
                "../DataList/lock/023bff4c-257e-42f4-8bc5-2e46eb805e65.jpg",
                "../DataList/lock/dae56253-1a6c-493f-ad02-93266fb29ed2.jpg"
            ]
        },
        {
            "id": "video-chat",
            "name": "Multiplayer Video Chat",
            "description": "In-game video chat system for multiplayer games. Enable players to communicate face-to-face. Features webcam integration, picture-in-picture display, mute controls, and seamless network replication.",
            "price": 7,
            "currency": "USD",
            "link": "https://www.fab.com/listings/a07aa037-ba61-4b02-81b4-028a21232281",
            "tags": ["Communication", "Video", "Multiplayer"],
            "featured": false,
            "images": [
                "../DataList/videochat.jpg"
            ]
        },
        {
            "id": "editor-save",
            "name": "Editor Save System",
            "description": "Save and load system for Unreal Editor. Preserve your work and settings effortlessly. Quick save/load functionality, multiple save slots, and seamless integration with Unreal Editor workflow.",
            "price": 3,
            "currency": "USD",
            "link": "https://www.fab.com/listings/1f370f2b-2bd7-4aa7-a9fb-343be515371e",
            "tags": ["Editor", "Utility", "Save/Load"],
            "featured": false,
            "images": [
                "../DataList/editorsave.jpg"
            ]
        }
    ],
    "siteInfo": {
        "storeName": "SametStore",
        "tagline": "Premium Unreal Engine Assets",
        "fabStoreUrl": "https://www.fab.com/sellers/SametStore",
        "aboutText": "SametStore is a dedicated Unreal Engine asset developer focused on creating high-quality, production-ready multiplayer systems and game mechanics. With a passion for game development and years of experience in Unreal Engine, we deliver assets that are not just functional, but also well-optimized and thoroughly documented.",
        "aboutText2": "Every asset we create is built with multiplayer in mind, ensuring seamless replication and synchronization across all clients. We believe in providing value to indie developers and studios alike, helping them accelerate their game development process."
    }
};

// ========================================
// Load Assets Data from JSON
// ========================================
async function loadAssetsData() {
    try {
        // Try to load from localStorage first (for admin edits)
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
                assetsData = DEFAULT_ASSETS_DATA;
            }
        }

        // Render all content
        renderAssets();
        renderHeroCards();
        renderAboutSection();
        renderFooterAssets();
        updateAssetCounts();
        initAnimations();

    } catch (error) {
        console.error('Error loading assets:', error);
        // Last resort: use default data
        assetsData = DEFAULT_ASSETS_DATA;
        renderAssets();
        renderHeroCards();
        renderAboutSection();
        renderFooterAssets();
        updateAssetCounts();
        initAnimations();
    }
}

// ========================================
// Render Assets Grid
// ========================================
function renderAssets() {
    const grid = document.getElementById('assets-grid');
    if (!assetsData || !assetsData.assets) return;

    grid.innerHTML = assetsData.assets.map(asset => `
        <article class="asset-card ${asset.featured ? 'featured' : ''}" data-asset-id="${asset.id}" onclick="openAssetModal('${asset.id}')">
            ${asset.featured ? '<div class="asset-badge">⭐ Featured</div>' : ''}
            <div class="asset-gallery">
                <div class="gallery-main">
                    <img src="${asset.images[0]}" alt="${asset.name}">
                </div>
                ${asset.images.length > 1 ? `
                    <div class="gallery-thumbs">
                        ${asset.images.slice(1, 4).map(img => `
                            <img src="${img}" alt="${asset.name}" class="thumb">
                        `).join('')}
                    </div>
                ` : ''}
            </div>
            <div class="asset-content">
                <h3 class="asset-title">${asset.name}</h3>
                <p class="asset-description">${asset.description}</p>
                <div class="asset-tags">
                    ${asset.tags.map(tag => `<span class="tag">${tag}</span>`).join('')}
                </div>
                <div class="asset-footer">
                    <span class="asset-price">$${asset.price} ${asset.currency}</span>
                    <span class="view-details-btn">
                        View Details
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M5 12h14M12 5l7 7-7 7"/>
                        </svg>
                    </span>
                </div>
            </div>
        </article>
    `).join('');

    // Re-initialize thumbnail hover effects
    initGalleryThumbs();
}

// ========================================
// Gallery Thumbnail Hover Effects
// ========================================
function initGalleryThumbs() {
    const assetCards = document.querySelectorAll('.asset-card');

    assetCards.forEach(card => {
        const thumbs = card.querySelectorAll('.thumb');
        const mainImage = card.querySelector('.gallery-main img');

        if (thumbs.length > 0 && mainImage) {
            const originalSrc = mainImage.src;

            thumbs.forEach(thumb => {
                thumb.addEventListener('mouseenter', (e) => {
                    e.stopPropagation();
                    mainImage.style.opacity = '0';
                    setTimeout(() => {
                        mainImage.src = thumb.src;
                        mainImage.style.opacity = '1';
                    }, 150);
                });
            });

            card.addEventListener('mouseleave', () => {
                mainImage.style.opacity = '0';
                setTimeout(() => {
                    mainImage.src = originalSrc;
                    mainImage.style.opacity = '1';
                }, 150);
            });
        }
    });
}

// ========================================
// Render Hero Cards
// ========================================
function renderHeroCards() {
    if (!assetsData || !assetsData.assets) return;

    const heroCards = [
        document.getElementById('hero-card-1'),
        document.getElementById('hero-card-2'),
        document.getElementById('hero-card-3')
    ];

    // Get first 3 assets with images
    const assetsWithImages = assetsData.assets.filter(a => a.images && a.images.length > 0);

    heroCards.forEach((card, index) => {
        if (card && assetsWithImages[index]) {
            card.innerHTML = `<img src="${assetsWithImages[index].images[0]}" alt="${assetsWithImages[index].name}">`;
        }
    });
}

// ========================================
// Render About Section
// ========================================
function renderAboutSection() {
    if (!assetsData || !assetsData.siteInfo) return;

    const aboutText1 = document.getElementById('about-text-1');
    const aboutText2 = document.getElementById('about-text-2');

    if (aboutText1) aboutText1.textContent = assetsData.siteInfo.aboutText;
    if (aboutText2) aboutText2.textContent = assetsData.siteInfo.aboutText2;
}

// ========================================
// Render Footer Assets
// ========================================
function renderFooterAssets() {
    if (!assetsData || !assetsData.assets) return;

    const footerAssets = document.querySelector('#footer-assets ul');
    if (!footerAssets) return;

    footerAssets.innerHTML = assetsData.assets.slice(0, 4).map(asset => `
        <li><a href="${asset.link}" target="_blank">${asset.name.split(' ').slice(0, 3).join(' ')}</a></li>
    `).join('');
}

// ========================================
// Update Asset Counts
// ========================================
function updateAssetCounts() {
    if (!assetsData || !assetsData.assets) return;

    const count = assetsData.assets.length;
    const countElements = [
        document.getElementById('asset-count'),
        document.getElementById('about-asset-count')
    ];

    countElements.forEach(el => {
        if (el) el.textContent = count + '+';
    });
}

// ========================================
// Modal Functions
// ========================================
function initModal() {
    const modal = document.getElementById('asset-modal');
    const closeBtn = document.getElementById('modal-close');
    const prevBtn = document.getElementById('gallery-prev');
    const nextBtn = document.getElementById('gallery-next');

    // Close modal
    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (!modal.classList.contains('active')) return;

        if (e.key === 'Escape') closeModal();
        if (e.key === 'ArrowLeft') prevImage();
        if (e.key === 'ArrowRight') nextImage();
    });

    // Gallery navigation
    prevBtn.addEventListener('click', prevImage);
    nextBtn.addEventListener('click', nextImage);
}

function openAssetModal(assetId) {
    const asset = assetsData.assets.find(a => a.id === assetId);
    if (!asset) return;

    currentModalAsset = asset;
    currentImageIndex = 0;

    const modal = document.getElementById('asset-modal');

    // Populate modal content
    document.getElementById('modal-badge').textContent = asset.featured ? '⭐ Featured' : '🎮 Asset';
    document.getElementById('modal-title').textContent = asset.name;
    document.getElementById('modal-description').textContent = asset.description;
    document.getElementById('modal-price').textContent = `$${asset.price} ${asset.currency}`;
    document.getElementById('modal-buy-btn').href = asset.link;

    // Tags
    document.getElementById('modal-tags').innerHTML = asset.tags.map(tag =>
        `<span class="tag">${tag}</span>`
    ).join('');

    // Gallery
    updateModalGallery();

    // Show modal
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function updateModalGallery() {
    const mainImg = document.getElementById('modal-main-img');
    const thumbsContainer = document.getElementById('modal-thumbs');

    // Update main image
    mainImg.src = currentModalAsset.images[currentImageIndex];

    // Update thumbnails
    thumbsContainer.innerHTML = currentModalAsset.images.map((img, index) => `
        <img src="${img}" alt="Thumbnail ${index + 1}" 
             class="${index === currentImageIndex ? 'active' : ''}"
             onclick="goToImage(${index})">
    `).join('');

    // Show/hide navigation buttons
    const prevBtn = document.getElementById('gallery-prev');
    const nextBtn = document.getElementById('gallery-next');

    prevBtn.style.display = currentModalAsset.images.length > 1 ? 'flex' : 'none';
    nextBtn.style.display = currentModalAsset.images.length > 1 ? 'flex' : 'none';
}

function goToImage(index) {
    currentImageIndex = index;
    const mainImg = document.getElementById('modal-main-img');
    mainImg.style.opacity = '0';
    setTimeout(() => {
        updateModalGallery();
        mainImg.style.opacity = '1';
    }, 150);
}

function prevImage() {
    if (!currentModalAsset) return;
    currentImageIndex = (currentImageIndex - 1 + currentModalAsset.images.length) % currentModalAsset.images.length;
    goToImage(currentImageIndex);
}

function nextImage() {
    if (!currentModalAsset) return;
    currentImageIndex = (currentImageIndex + 1) % currentModalAsset.images.length;
    goToImage(currentImageIndex);
}

function closeModal() {
    const modal = document.getElementById('asset-modal');
    modal.classList.remove('active');
    document.body.style.overflow = '';
    currentModalAsset = null;
    currentImageIndex = 0;
}

// ========================================
// Navbar Scroll Effect
// ========================================
function initNavbar() {
    const navbar = document.querySelector('.navbar');

    window.addEventListener('scroll', () => {
        const currentScroll = window.pageYOffset;

        if (currentScroll > 50) {
            navbar.style.background = 'rgba(10, 15, 13, 0.95)';
            navbar.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.3)';
        } else {
            navbar.style.background = 'rgba(10, 15, 13, 0.85)';
            navbar.style.boxShadow = 'none';
        }
    });

    // Smooth scroll for navigation links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
                closeMobileMenu();
            }
        });
    });
}

// ========================================
// Scroll Animations
// ========================================
function initAnimations() {
    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.1
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate-in');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    // Observe all asset cards
    document.querySelectorAll('.asset-card').forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(30px)';
        card.style.transition = `all 0.6s ease ${index * 0.1}s`;
        observer.observe(card);
    });

    // Observe about section
    const aboutSection = document.querySelector('.about-content');
    if (aboutSection) {
        aboutSection.style.opacity = '0';
        aboutSection.style.transform = 'translateX(-30px)';
        aboutSection.style.transition = 'all 0.8s ease';
        observer.observe(aboutSection);
    }

    const aboutCard = document.querySelector('.about-card');
    if (aboutCard) {
        aboutCard.style.opacity = '0';
        aboutCard.style.transform = 'translateX(30px)';
        aboutCard.style.transition = 'all 0.8s ease 0.2s';
        observer.observe(aboutCard);
    }
}

// Add animate-in class styles
const style = document.createElement('style');
style.textContent = `
    .animate-in {
        opacity: 1 !important;
        transform: translate(0) !important;
    }
`;
document.head.appendChild(style);

// ========================================
// Mobile Menu
// ========================================
function initMobileMenu() {
    const menuBtn = document.querySelector('.mobile-menu-btn');
    const navLinks = document.querySelector('.nav-links');

    if (menuBtn && navLinks) {
        menuBtn.addEventListener('click', () => {
            const isOpen = navLinks.classList.contains('mobile-open');

            if (isOpen) {
                closeMobileMenu();
            } else {
                openMobileMenu();
            }
        });
    }
}

function openMobileMenu() {
    const navLinks = document.querySelector('.nav-links');
    const menuBtn = document.querySelector('.mobile-menu-btn');

    navLinks.classList.add('mobile-open');
    menuBtn.classList.add('active');

    navLinks.style.display = 'flex';
    navLinks.style.flexDirection = 'column';
    navLinks.style.position = 'absolute';
    navLinks.style.top = '100%';
    navLinks.style.left = '0';
    navLinks.style.right = '0';
    navLinks.style.background = 'rgba(10, 15, 13, 0.98)';
    navLinks.style.padding = '1.5rem';
    navLinks.style.gap = '1rem';
    navLinks.style.borderTop = '1px solid rgba(255, 255, 255, 0.08)';
    navLinks.style.animation = 'slideDown 0.3s ease';
}

function closeMobileMenu() {
    const navLinks = document.querySelector('.nav-links');
    const menuBtn = document.querySelector('.mobile-menu-btn');

    if (navLinks && menuBtn) {
        navLinks.classList.remove('mobile-open');
        menuBtn.classList.remove('active');

        if (window.innerWidth > 768) {
            navLinks.style.display = '';
            navLinks.style.flexDirection = '';
            navLinks.style.position = '';
            navLinks.style.top = '';
            navLinks.style.left = '';
            navLinks.style.right = '';
            navLinks.style.background = '';
            navLinks.style.padding = '';
            navLinks.style.gap = '';
            navLinks.style.borderTop = '';
            navLinks.style.animation = '';
        } else {
            navLinks.style.display = 'none';
        }
    }
}

// Handle window resize
window.addEventListener('resize', () => {
    const navLinks = document.querySelector('.nav-links');
    if (window.innerWidth > 768 && navLinks) {
        navLinks.style.display = '';
        navLinks.style.flexDirection = '';
        navLinks.style.position = '';
        navLinks.style.top = '';
        navLinks.style.left = '';
        navLinks.style.right = '';
        navLinks.style.background = '';
        navLinks.style.padding = '';
        navLinks.style.gap = '';
        navLinks.style.borderTop = '';
        navLinks.style.animation = '';
        navLinks.classList.remove('mobile-open');
    }
});

// Add animations
const slideStyle = document.createElement('style');
slideStyle.textContent = `
    @keyframes slideDown {
        from {
            opacity: 0;
            transform: translateY(-10px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }
    
    .mobile-menu-btn.active span:nth-child(1) {
        transform: rotate(45deg) translate(5px, 5px);
    }
    
    .mobile-menu-btn.active span:nth-child(2) {
        opacity: 0;
    }
    
    .mobile-menu-btn.active span:nth-child(3) {
        transform: rotate(-45deg) translate(5px, -5px);
    }
`;
document.head.appendChild(slideStyle);

// ========================================
// Parallax Effect for Hero Cards
// ========================================
document.addEventListener('mousemove', (e) => {
    const cards = document.querySelectorAll('.floating-card');
    const mouseX = e.clientX / window.innerWidth - 0.5;
    const mouseY = e.clientY / window.innerHeight - 0.5;

    cards.forEach((card, index) => {
        const speed = (index + 1) * 10;
        const x = mouseX * speed;
        const y = mouseY * speed;
        card.style.transform = `translate(${x}px, ${y}px)`;
    });
});

// Console Easter Egg
console.log('%c🎮 SametStore Portfolio', 'font-size: 24px; font-weight: bold; color: #10b981;');
console.log('%cBuilt with ❤️ for game developers', 'font-size: 14px; color: #14b8a6;');
