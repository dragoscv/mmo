#!/bin/bash
set -e
cd /Users/dragos
mkdir -p bin
if [ ! -x /Users/dragos/node-v20.18.1-darwin-x64/bin/node ]; then
  echo "[install-node] downloading"
  curl -fsSL -o node.tar.gz https://nodejs.org/dist/v20.18.1/node-v20.18.1-darwin-x64.tar.gz
  tar -xzf node.tar.gz
  rm node.tar.gz
fi
ln -sf /Users/dragos/node-v20.18.1-darwin-x64/bin/node bin/node
ln -sf /Users/dragos/node-v20.18.1-darwin-x64/bin/npm  bin/npm
ln -sf /Users/dragos/node-v20.18.1-darwin-x64/bin/npx  bin/npx
grep -q "/Users/dragos/bin" ~/.zshrc 2>/dev/null || echo 'export PATH=/Users/dragos/bin:$PATH' >> ~/.zshrc
export PATH=/Users/dragos/bin:$PATH
echo "[install-node] node=$(node -v) npm=$(npm -v)"