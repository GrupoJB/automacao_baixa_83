# Automação MyTracking - Base 83

Este projeto automatiza o download de relatórios CSV do MyTracking e os salva diretamente em um servidor de rede (SMB/Samba) ou pasta local.

## 🚀 Como Rodar

### 1. Instalação das Dependências
No terminal, dentro da pasta do projeto, execute:
```bash
npm install
```

### 2. Configuração (Arquivo .env)
O arquivo `.env` já deve estar configurado, mas caso precise alterar, estas são as variáveis principais:
- `MYTRACKING_USER / PASS`: Credenciais do MyTracking.
- `BASE_OUTPUT_PATH`: Caminho de destino (Ex: `\\tc-for-srv-002\Indicadores\bases_automacao\base_83`).
- `SMB_USER / PASS / DOMAIN`: Credenciais para acessar o servidor de rede.

### 3. Preparação do Ambiente (Apenas Linux)
Se for rodar em um servidor Linux, você precisa instalar o navegador (Chromium) e as bibliotecas de sistema necessárias para o Playwright:

```bash
# Instalar o navegador
npx playwright install chromium

# Instalar dependências de sistema (Exige privilégios de administrador/sudo)
sudo npx playwright install-deps
```

> **Nota:** Caso não tenha acesso ao `sudo`, peça ao administrador do servidor para instalar as dependências do Playwright.

### 4. Execução
Para iniciar a automação:
```bash
npm start
```

## 📂 Estrutura de Pastas
O script salvará os arquivos seguindo esta lógica:
`[CAMINHO_REDE] / [FILIAL] / [PERIODO].csv`

Exemplo: `\\tc-for-srv-002\Indicadores\bases_automacao\base_83\FOR\26.05.csv`

## 🛠️ Solução de Problemas
- **Erro de Permissão SMB**: Verifique se o usuário e senha no `.env` têm permissão de escrita na pasta de destino.
- **Limite de Execução**: O script detecta automaticamente a mensagem de limite do MyTracking e tenta trocar para o próximo usuário da lista.
- **Cabeçalho/Data**: O script faz o split automático dos períodos (01 e 02) conforme as regras do mês atual e passado.
