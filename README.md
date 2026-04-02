# ⚡ Hogwarts — Jogo dos 10 Erros

Dinâmica multiplayer temática Harry Potter para rodar em servidor local.

## Pré-requisitos

- [Node.js](https://nodejs.org/) v16 ou superior

## Instalação

```bash
# Entre na pasta do projeto
cd hp-game

# Instale as dependências (só na primeira vez)
npm install
```

## Configuração

Edite o arquivo `.env` para definir a senha do Master e a porta:

```
PORT=3000
MASTER_PASSWORD=hogwarts2025
```

> A senha do Master **nunca** aparece no HTML — fica apenas no servidor.

## Rodando o servidor

```bash
npm start
```

O terminal mostrará:

```
⚡ Servidor de Hogwarts rodando em http://localhost:3000
🔮 Senha do Master: hogwarts2025
```

## Como usar

### Para o Master (você)
1. Abra `http://localhost:3000` no seu computador
2. Digite seu nome, escolha sua casa, coloque o **código da sala** (ex: `SIEG2025`)
3. Digite a **senha do Master** no campo correspondente
4. Clique em **Entrar em Hogwarts**
5. Aguarde os jogadores na Sala de Espera
6. Clique **Iniciar o Jogo** quando todos estiverem presentes
7. Durante o jogo, veja o placar e os cliques de cada um em tempo real
8. Quando houver vencedor, clique **Anunciar Vencedor**

### Para os jogadores
1. Acessam `http://SEU_IP_LOCAL:3000` (ex: `http://192.168.1.10:3000`)
2. Digitam nome, escolhem casa, inserem o **código da sala** (o mesmo que o Master usou)
3. Deixam a senha em branco
4. Aguardam na Sala de Espera
5. Quando o jogo iniciar, clicam nas diferenças na imagem da **DIREITA**

## Encontrando seu IP local

**Windows:**
```
ipconfig
```
Procure por "Endereço IPv4" — geralmente `192.168.x.x`

**Mac/Linux:**
```
ifconfig | grep "inet "
```

## Segurança

- A senha do Master e as posições dos erros ficam **apenas no servidor**
- Os jogadores não têm como inspecionar o HTML para descobrir a senha
- As imagens são servidas pelo servidor — não há risco de exposição
- Validação dos cliques é feita no backend (não dá para trapacear via DevTools)

## Estrutura do projeto

```
hp-game/
├── server.js          ← Servidor Node.js + WebSocket
├── .env               ← Senha do Master (não compartilhe!)
├── package.json
└── public/
    ├── index.html     ← Frontend (sem segredos)
    └── images/
        ├── original.webp   ← Imagem original
        └── modified.webp   ← Imagem com os 10 erros
```
