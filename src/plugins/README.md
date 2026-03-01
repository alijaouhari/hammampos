# HammamPOS Plugin System

This directory contains the plugin architecture for HammamPOS premium features.

## Directory Structure

```
plugins/
├── core/                    # Core plugin system
│   ├── PluginLoader.js     # Main plugin loading engine
│   ├── PluginManager.js    # Plugin lifecycle management
│   ├── LicenseManager.js   # Hardware-based licensing
│   └── interfaces/         # TypeScript interfaces
├── registry/               # Plugin registry and metadata
└── features/              # Premium feature plugins
    ├── inventory-management/
    ├── spa-appointments/
    ├── commission-system/
    └── loyalty-cards/
```

## Plugin Development

Each plugin must follow the standardized structure:
- `plugin.json` - Metadata and dependencies
- `main.js` - Entry point and initialization
- `database/` - Schema extensions
- `ui/` - User interface components
- `services/` - Business logic

## Loading Process

1. Scan `features/` directory for plugin folders
2. Read `plugin.json` metadata
3. Validate dependencies and licensing
4. Load plugins in dependency order
5. Initialize and register with core system