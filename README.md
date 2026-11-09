# ZMQT-Ini

## Generate ZeroMQ code

Install Node.js 26.13.0 with npm and put both on `PATH`. Run setup after cloning the repository and after changes to Core source or dependencies.

### Windows PowerShell 5.1 or 7

```powershell
.\scripts\setup.ps1
.\scripts\generate.ps1 .\config.json .\out
```

### macOS or Linux

```bash
bash scripts/setup.sh
bash scripts/generate.sh ./config.json ./out
```

Use a UTF-8 JSON configuration that follows the [configuration schema](packages/generator-core/resources/config.schema.json). Choose a new output directory with an existing parent. Relative input and output paths use your current directory. The CLI prints the manifest and diagnostics as JSON.

Follow the generated project's README to install its dependencies and run it.
