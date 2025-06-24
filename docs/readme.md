# Documentation

## Table of Contents

- [Documentation](#documentation)
  - [Table of Contents](#table-of-contents)
  - [Project Information](#project-information)
  - [Project Setup](#project-setup)
    - [Prerequisites](#prerequisites)
    - [Installation](#install-and-run)
  - [Usage](#usage)

## Project Information

This is a CS Capstone project for student Matthias Kebede, being advised by Sarah Nadi and May Mahmoud. The objective of the project is to create a plugin that integrates the existing LibMig tool into Visual Studio Code. LibMig is a CLI tool that allows the user to automate the migration of Python libraries by using LLMs.

## Project Setup

### Prerequisites
1. Install [Node.js](https://nodejs.org/en/download)
2. Install [Visual Studio Code](https://code.visualstudio.com/download)
3. Install [Git](https://git-scm.com/downloads)

### Install and Run
1. Clone the repo

```bash
   git clone <repo>
```

2. Navigate to the project directory

3. Install dependencies

```bash
   npm install
```

4. Open Visual Studio Code

```bash
   code .
```

5. Build and Run the Extension
  - Press `F5` in VS Code to launch a new Extension Development Host window
  - This should automatically build the extension and load it, but if it doesn't you can try `npm run compile` from the command line.

## Usage

With VS Code open and the extension running, you can now use the plugin's commands (make sure you are in the right VS Code window). Press `CTRL+SHIFT+P` to access the command palette. You can also see [VS Code Extension Quickstart](./vsc-extension-quickstart.md) for more information.

The current version is an early prototype, and uses stubs/mocks accordingly. A sample Python project is provided for basic usage.

Commands:
- LibMig: Hello World
- LibMig: Migrate a Library
- LibMig: Show Migration Preview
- LibMig: Backup a file before migrating
- LibMig: Restore a migrated file

Misc:
- Hover over a library in `requirements.txt` to initiate a migration using it as the chosen source library.
- Right click within the editor (while in `requirements.txt`) and click 'Migrate a Library' to initiate a migration without opening the command palette. A Quick Pick menu will prompt you to select a source library from those detected, followed by a target library (which currently matches the source library options, with the one you chose filtered out).