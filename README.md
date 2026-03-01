# 🏛️ HammamPOS Desktop - Professional Edition

**Enterprise-grade Point of Sale system for Moroccan hammams and spas**

[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](#)
[![License](https://img.shields.io/badge/license-Proprietary-red.svg)](#)

## 🚀 Quick Start

### Installation
1. Download `HammamPOS-Setup.exe`
2. Run installer as Administrator
3. Follow installation wizard
4. Launch HammamPOS from desktop or Start Menu

### Development Setup
```bash
npm install
npm start
```

## 📦 Features

### Core System
- ✅ **Point of Sale** - Complete POS functionality with Arabic interface
- ✅ **Excel Integration** - Automatic Excel file generation and mirroring
- ✅ **Thermal Printing** - 58mm receipt printer support
- ✅ **Data Management** - SQLite database with comprehensive backup system

### Premium Features
- 🔌 **Plugin System** - Extensible architecture with hot reloading
- 🔐 **Hardware Licensing** - Secure feature activation system
- 🌐 **Web Dashboard** - Remote access via http://localhost:3000
- ☁️ **Cloud Sync** - Google Drive integration framework
- 📦 **Professional Installer** - Enterprise deployment ready

## 🏗️ Architecture

```
hammampos-desktop/
├── src/
│   ├── main/           # Electron main process
│   ├── renderer/       # UI and frontend
│   ├── services/       # Business logic services
│   └── plugins/        # Plugin system
├── data/               # Database and data files
├── tools/              # Utility scripts
├── installer/          # Professional installer configuration
└── resources/          # Application assets
```

## 🔧 Configuration

### Data Directory
- **Default**: `%APPDATA%\HammamPOS\data`
- **Customizable** during installation
- Contains: database, Excel files, licenses

### Premium Features
Premium features require license activation:
1. Get Machine ID from Settings > About
2. Generate license: `node tools/license-generator.js feature-name machine-id`
3. Send activation key to customer
4. Customer enters key in Settings > Premium Features

## 🌐 Web Dashboard

Access the web dashboard at http://localhost:3000
- **Authentication**: Use admin password
- **Features**: Business metrics, reports, remote monitoring
- **Mobile-friendly**: Responsive design

## 📊 Excel Integration

All data is automatically exported to Excel format at `data/hammampos.xlsx` with 10 worksheets including sales, expenses, collections, and daily summaries. The Excel file updates in real-time as you use the application.

## 🛠️ Development

### Build Commands
```bash
npm start              # Development mode
npm run pack           # Build application
npm run build:win      # Create installer
npm run build:installer # Create Inno Setup installer
```

### Plugin Development
See `src/plugins/README.md` for plugin development guide.

## 📋 System Requirements

### Minimum Requirements
- **OS**: Windows 10 (64-bit)
- **RAM**: 4GB
- **Storage**: 500MB free space
- **Network**: Internet for cloud features (optional)

### Recommended
- **OS**: Windows 11
- **RAM**: 8GB
- **Storage**: 2GB free space
- **Printer**: Thermal receipt printer (optional)

## 🔐 Security

- Hardware-based licensing prevents unauthorized use
- Local data encryption
- Secure web dashboard with JWT authentication
- Regular security updates

## 📞 Support

- **Documentation**: See included guides
- **License Issues**: Contact with Machine ID
- **Technical Support**: Available for licensed users

## 📄 License

Proprietary software. See LICENSE.txt for terms.

---

**HammamPOS Desktop** - Professional hammam management made simple.