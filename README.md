# 📖 Libertary

> *"Liberate your library. Read on the go, anytime, anywhere — because reading should never be stopped."*

**Libertary** is a premium, offline-first Web PDF Ebook Reader designed to turn your local PDF collection into an immersive, book-like reading experience directly on your laptop. Whether you are offline, traveling, or just taking your laptop with you on the go, Libertary brings your personal library to life with hyper-realistic 3D page flips and modern reading tools.

---

## ✨ Features

- 📚 **Local Vault & Folder Scanning**: Point Libertary to any folder on your laptop using native browser File System APIs to automatically index your PDF ebooks.
- 📄 **Realistic 3D Page Flip**: Enjoy book-flipping physics and tactile animations powered by `StPageFlip`.
- ⚡ **Offline PWA Support**: Install Libertary as a desktop app via Chrome/Edge. Once installed, it runs completely offline without needing a terminal or local dev server.
- 🎨 **In-Book Annotations**: Draw, highlight, write, or present using the Pen, Highlighter, Laser Pointer, and Eraser tools.
- 📝 **Personal Notebook**: Jot down notes per page, search your notes, and export them as clean Markdown files (`.md`).
- 🔖 **Smart Bookmarking & Resuming**: Automatically remembers your last read page so you can jump right back in.
- 🧭 **Quick Table of Contents**: Seamlessly toggle the table of contents sidebar to jump across chapters.
- 🌙 **Sleek Glassmorphism Interface**: Tailored dark-mode UI with dynamic sliding sidebars on hover/click.

---

## 🚀 Quick Start & Installation

### Option A: Install as Desktop App (PWA)
1. Open Libertary in Chrome or Edge.
2. Click the **Install** icon in the browser address bar.
3. Launch Libertary anytime directly from your Desktop or Start Menu — **no internet or local dev server required!**

### Option B: Local Development
```bash
# Clone the repository
git clone https://github.com/artacee/Libertary.git

# Navigate into the project folder
cd Libertary

# Start a local web server (e.g. using serve)
npx serve . -l 3000
```
Then open `http://localhost:3000` in your web browser.

---

## 🛠️ Technology Stack

- **Core**: Vanilla HTML5 & JavaScript (ES Modules)
- **Styling**: Modern CSS3 (Variables, Glassmorphism, Animations)
- **PDF Rendering**: [PDF.js](https://mozilla.github.io/pdf.js/)
- **Page Flip Engine**: [StPageFlip](https://nodegarden.github.io/page-flip/)
- **Offline & Storage**: Web Service Workers, IndexedDB, File System Access API

---

## 📄 License

Distributed under the MIT License. Feel free to use, modify, and liberate your reading experience!
