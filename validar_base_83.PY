import os
import re
import pandas as pd
from colorama import Fore, Style, init
from dotenv import load_dotenv

# Carregar variáveis de ambiente do .env
load_dotenv()

# Inicializa colorama para colorir o terminal
init(autoreset=True)

# Caminho base da BASE FISCAL
def get_base_path():
    path_env = os.getenv("BASE_OUTPUT_PATH")
    if not path_env:
        return "/mnt/c/Users/luhan.vinicius/grupojb.log.br/tc - DATABASE PAINEL/BASE FISCAL"
    
    # Se estiver no Linux, converte //servidor/share para /mnt/share
    if os.name == 'posix' and (path_env.startswith('//') or path_env.startswith('\\\\')):
        parts = [p for p in path_env.replace('\\', '/').split('/') if p]
        if len(parts) >= 2:
            share = parts[1]
            subpath = '/'.join(parts[2:])
            return f"/mnt/{share}/{subpath}"
    return path_env

base_path = get_base_path()

# Subpastas e CDs esperados
filiais = {
    "FOR": "FORTALEZA",
    "IMP": "IMPERATRIZ",
    "JUA": "JUAZEIRO",
    "SLZ": "SÃO LUÍS",
    "SOB": "SOBRAL",
    "THE": "TERESINA"
}

# Armazenamento de erros
erros = []
total_arquivos = 0
formatos_corrigidos = []

# Expressão regular para capturar o prefixo YY.MM
prefixo_pattern = re.compile(r"^(\d{2})\.(\d{2})")

# Função para leitura robusta
def ler_csv_com_tentativas(caminho_arquivo):
    encodings_teste = ["utf-8", "latin1", "iso-8859-1", "cp1252"]
    for enc in encodings_teste:
        try:
            df = pd.read_csv(caminho_arquivo, encoding=enc, low_memory=False)
            return df
        except Exception:
            continue
    raise UnicodeDecodeError("Não foi possível decodificar o arquivo com encodings comuns")

# Função robusta para converter datas
def converter_datas_coluna(series, nome_arquivo):
    series = series.astype(str).str.strip()
    series = series.replace(["nan", "None", ""], pd.NA)
    exemplo = series.dropna().iloc[0] if not series.dropna().empty else None
    formato_detectado = None

    if exemplo:
        if re.match(r"^\d{2}/\d{2}/\d{4}", exemplo):  # dd/mm/yyyy hh:mm:ss
            formato_detectado = "%d/%m/%Y %H:%M:%S" if ":" in exemplo else "%d/%m/%Y"
        elif re.match(r"^\d{4}-\d{2}-\d{2}", exemplo):  # yyyy-mm-dd hh:mm:ss
            formato_detectado = "%Y-%m-%d %H:%M:%S" if ":" in exemplo else "%Y-%m-%d"
        elif re.match(r"^\d{4}\.\d{2}\.\d{2}", exemplo):  # yyyy.mm.dd
            formato_detectado = "%Y.%m.%d %H:%M:%S" if ":" in exemplo else "%Y.%m.%d"
        elif re.match(r"^\d{4}\.\d{2}\.\d{2}", exemplo):  # yyyy.dd.mm invertido
            formato_detectado = "%Y.%d.%m %H:%M:%S" if ":" in exemplo else "%Y.%d.%m"

    if formato_detectado:
        datas = pd.to_datetime(series, format=formato_detectado, errors="coerce")
        if "dd.%m" in formato_detectado and nome_arquivo not in formatos_corrigidos:
            formatos_corrigidos.append(nome_arquivo)
    else:
        datas = pd.to_datetime(series, errors="coerce", dayfirst=True)

    return datas

# Validação principal
def validar_csv(caminho_arquivo, sigla, filial_nome):
    nome_arquivo = os.path.basename(caminho_arquivo)

    try:
        # Testa separador incorreto
        with open(caminho_arquivo, "r", encoding="latin1") as f:
            primeira_linha = f.readline()
            if ";" in primeira_linha:
                erros.append((sigla, nome_arquivo, "Separador incorreto (usando ponto e vírgula)"))
                return

        # Identifica ano e mês pelo nome do arquivo
        m = prefixo_pattern.match(nome_arquivo)
        if not m:
            erros.append((sigla, nome_arquivo, "Nome do arquivo sem prefixo válido 'YY.MM'"))
            return
        esperado_ano = 2000 + int(m.group(1))
        esperado_mes = int(m.group(2))

        df = ler_csv_com_tentativas(caminho_arquivo)

        # Valida CD
        if "CD" in df.columns:
            cds_invalidos = df[df["CD"] != filial_nome]
            if not cds_invalidos.empty:
                valor_errado = cds_invalidos["CD"].unique()
                erros.append((sigla, nome_arquivo, f"CD incorreto → encontrado {list(valor_errado)}, esperado '{filial_nome}'"))
        else:
            erros.append((sigla, nome_arquivo, "Coluna 'CD' ausente no arquivo"))

        # Valida Data Inserção
        if "Data Inserção" in df.columns:
            df["Data Inserção_conv"] = converter_datas_coluna(df["Data Inserção"], nome_arquivo)
            total_linhas = len(df)
            n_invalidas = df["Data Inserção_conv"].isna().sum()

            if n_invalidas > 0 and n_invalidas != total_linhas:
                perc = (n_invalidas / total_linhas) * 100
                erros.append((sigla, nome_arquivo, f"{n_invalidas} registros inválidos ({perc:.1f}%) em 'Data Inserção'"))
            elif n_invalidas == total_linhas:
                erros.append((sigla, nome_arquivo, f"Todas as {total_linhas} datas inválidas — possível formatação desconhecida"))

            # Verifica se o mês/ano batem com o nome do arquivo
            mask_diferente = (
                (df["Data Inserção_conv"].dt.year != esperado_ano) |
                (df["Data Inserção_conv"].dt.month != esperado_mes)
            )
            datas_invalidas = df.loc[mask_diferente, "Data Inserção_conv"].dropna()

            if not datas_invalidas.empty:
                qtd = len(datas_invalidas)
                exemplos = datas_invalidas.astype(str).unique()[:5].tolist()
                erros.append((sigla, nome_arquivo, f"{qtd} registros fora de {esperado_mes:02d}/{esperado_ano}: exemplos {exemplos}"))
        else:
            erros.append((sigla, nome_arquivo, "Coluna 'Data Inserção' ausente no arquivo"))

    except Exception as e:
        erros.append((sigla, nome_arquivo, f"Erro ao ler arquivo: {str(e)}"))

# -------------------------
# EXECUÇÃO
# -------------------------
print(Fore.CYAN + "\n🔍 Iniciando validação de arquivos FISCAIS...\n")

for sigla, nome in filiais.items():
    pasta = os.path.join(base_path, sigla)
    if os.path.exists(pasta):
        print(Fore.YELLOW + f"📁 Verificando subpasta: {sigla} ({nome})")
        for arquivo in os.listdir(pasta):
            if arquivo.endswith(".csv"):
                total_arquivos += 1
                caminho_arquivo = os.path.join(pasta, arquivo)
                validar_csv(caminho_arquivo, sigla, nome)

print("\n" + "-" * 80)
print(Fore.CYAN + f"✅ Total de arquivos verificados: {total_arquivos}")

if erros:
    print(Fore.RED + f"❌ Arquivos com erro: {len(erros)}")
    print("-" * 80)
    df_erros = pd.DataFrame(erros, columns=["Subpasta", "Arquivo", "Descrição do Erro"])
    print(Fore.RED + df_erros.to_string(index=False))
else:
    print(Fore.GREEN + "🎉 Nenhum erro encontrado! Todos os arquivos estão dentro do padrão.")

if formatos_corrigidos:
    print("\n" + Fore.YELLOW + "⚠️  Formato invertido detectado e corrigido automaticamente nos arquivos:")
    for nome in formatos_corrigidos:
        print(Fore.YELLOW + f"   → {nome}")

print("-" * 80 + Style.RESET_ALL)
