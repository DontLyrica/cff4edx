import { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js'; 
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename); 

// --- YAPILANDIRMA VE BAĞLANTI ---

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

mongoose.connect(config.mongo)
    .then(() => console.log("✅ MongoDB bağlandı"))
    .catch(err => console.log("❌ MongoDB bağlantı hatası:", err));

// MongoDB Modellerini import et 
import User from './models/User.js'; 
import Arsa from './models/Arsa.js';
import GiftCode from './models/GiftCode.js'; 
import { ACTIVE_DUELS as ACTIVE_RULET_DUELS, handleRouletteInteractions } from './commands/rulet.js';

// --- BOT İSTEMCİSİ ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --- YARDIMCI SABİTLER ---

const TICKET_COOLDOWN_MS = 15 * 60 * 1000;
const CLOSE_DELAY_MS = 5000;

// Blackjack Sabitleri (BURAYI KENDİ KANAL ID'NİZLE DEĞİŞTİRİN!)
const BLACKJACK_CHANNEL_ID = '1441141353051586581'; 
const MAX_PLAYERS = 3;
const AUTO_START_DELAY_MS = 30000; // 30 saniye
const MAX_NO_BET_ROUNDS = 2;       // 2 el bahis yapmama hakkı

// Kart Değerleri
const CARD_SUITS = ['♠️', '♣️', '♥️', '♦️'];
const CARD_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// Global Oyun Durumları
global.blackjackTable = {
    messageId: null, 
    players: {},    // { userId: { bet: 0, cards: [], score: 0, isStanding: false, noBetCount: 0 } }
    dealer: { cards: [], score: 0 },
    status: 'LOBBY', // LOBBY, IN_GAME, DEALER_TURN, ROUND_OVER
    currentDeck: [], 
    currentPlayerIndex: 0,
    lastRoundMessageIds: [] 
};
global.towerGames = {}; // { userId: { bet: 1000, mode: 'kolay', stage: 0, ... } }


// --- TOWER SABİT VE YARDIMCI FONKSİYONLARININ TEKRAR TANIMI ---

const TOWER_MULTIPLIERS = {
    kolay: [1.29, 1.72, 2.30, 3.07, 4.09, 5.45, 7.27, 9.69, 12.92, 17.22, 22.97, 30.62],
    orta: [1.46, 2.18, 3.27, 4.91, 7.37, 11.05, 16.57, 24.86, 37.29, 55.94, 83.90, 125.85],
    // ZOR MOD GÜNCELLENDİ: Daha düşük başlangıç çarpanı (1.60x), yüksek artış korunuyor.
    zor: [1.60, 3.20, 6.40, 12.80, 25.60, 51.20, 102.40, 204.80, 409.60, 819.20] 
};

const MODE_CONFIG = {
    kolay: { doors: 4, wrong: 1, name: 'Kolay', color: '#00FF00' },
    orta: { doors: 3, wrong: 1, name: 'Orta', color: '#FFA500' },
    zor: { doors: 2, wrong: 1, name: 'Zor', color: '#FF0000' }
};

const MAX_STAGES = {
    kolay: TOWER_MULTIPLIERS.kolay.length,
    orta: TOWER_MULTIPLIERS.orta.length,
    zor: TOWER_MULTIPLIERS.zor.length
};


/** Tower oyun mesajını ve butonlarını günceller/oluşturur (tower.js'den kopyalanmıştır). */
function createTowerEmbed(game, userId, endResult = null) {
    const config = MODE_CONFIG[game.mode];
    const maxStage = MAX_STAGES[game.mode];
    const nextMultiplier = TOWER_MULTIPLIERS[game.mode][game.stage] || game.currentMultiplier;
    
    const embed = new EmbedBuilder()
        .setColor(config.color)
        .setTitle(`🏰 Kule Oyunu - ${config.name} Modu`)
        .setDescription(`**Oyuncu:** <@${userId}>\n**Bahis:** ${game.bet.toLocaleString()} 💰`)
        .addFields(
            { name: 'Seviye', value: `${game.stage + 1} / ${maxStage}`, inline: true },
            { name: 'Mevcut Çarpan', value: `**${game.currentMultiplier.toFixed(2)}×**`, inline: true },
            { name: 'Potansiyel Kazanç', value: `${(game.bet * game.currentMultiplier).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} 💰`, inline: true }
        )
        .setFooter({ text: `Doğru Kapı: ${config.doors - config.wrong}, Yanlış Kapı: ${config.wrong}` });

    const buttons = new ActionRowBuilder();
    
    for (let i = 1; i <= config.doors; i++) {
        const isWrong = game.wrongDoor.includes(i);
        let style = ButtonStyle.Secondary;
        let emoji = '🚪';
        let isDisabled = game.isCashout || !!endResult;
        
        if (endResult) {
            if (endResult === 'win') {
                style = ButtonStyle.Success;
                emoji = game.wrongDoor.includes(i) ? '❌' : '✅';
            } else if (endResult === 'lose') {
                if (i === game.lastChoice) {
                    style = ButtonStyle.Danger;
                    emoji = '💣';
                } else if (isWrong) {
                    emoji = '❌';
                }
            }
        }
        
        buttons.addComponents(
            new ButtonBuilder()
                .setCustomId(`tower_select_${i}`)
                .setLabel(endResult ? `${emoji} Kapı ${i}` : `Kapı ${i}`)
                .setStyle(style)
                .setDisabled(isDisabled)
        );
    }
    
    const actionRow2 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('tower_cashout')
                .setLabel(`💰 ${game.currentMultiplier.toFixed(2)}× Nakit Çek!`)
                .setStyle(ButtonStyle.Success)
                .setDisabled(game.isCashout || game.stage === 0 || !!endResult)
        );
        
    if (endResult === 'win') {
        embed.setDescription(`🎉 ${game.bet.toLocaleString()} 💰 Bahis Başarılı! **${game.currentMultiplier.toFixed(2)}×** çarpanla kazanç elde ettiniz.`);
    } else if (endResult === 'lose') {
        embed.setDescription(`💥 ${game.bet.toLocaleString()} 💰 Bahis Başarısız! Yanlış kapıyı seçtiniz. Kazanç: **0 💰**`);
    } else if (game.isCashout) {
         embed.setDescription(`✅ Nakit Çekildi! **${(game.bet * game.currentMultiplier).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} 💰** kazandınız.`);
    }

    return { embed: embed, components: [buttons, actionRow2] };
}


function getRandomWrongDoor(totalDoors, wrongDoors) {
    const wrongPositions = new Set();
    while (wrongPositions.size < wrongDoors) {
        // Kapılar 1'den başlar, bu yüzden 1 ile totalDoors arasında rastgele sayı üret
        wrongPositions.add(Math.floor(Math.random() * totalDoors) + 1); 
    }
    return Array.from(wrongPositions);
}
// --- YARDIMCI GENEL FONKSİYONLAR ---

function calculateXPForLevel(level) {
    if (level <= 1) return 300; 
    return Math.floor(300 + 75 * Math.pow(level, 1.7));
}

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    
    let parts = [];
    if (hours > 0) parts.push(`${hours} saat`);
    if (minutes > 0) parts.push(`${minutes} dakika`);
    else if (parts.length === 0) parts.push(`1 dakikadan az`);
    
    return parts.join(' ');
}

async function getUserData(userId) {
    let data = await User.findOne({ userId });
    if (!data) {
        data = new User({ userId });
        await data.save();
    }
    return data;
}

// --- BLACKJACK OYUN MEKANİKLERİ ---

function getCardValue(rank) {
    if (['J', 'Q', 'K', '10'].includes(rank)) return 10;
    if (rank === 'A') return 11;
    return parseInt(rank);
}

function calculateScore(cards) {
    let score = 0;
    let aceCount = 0;
    
    cards.forEach(card => {
        const rank = card.split('-')[1]; 
        score += getCardValue(rank);
        if (rank === 'A') aceCount++;
    });

    while (score > 21 && aceCount > 0) {
        score -= 10;
        aceCount--;
    }
    return score;
}

function createAndShuffleDeck() {
    let deck = [];
    for (const suit of CARD_SUITS) {
        for (const rank of CARD_RANKS) {
            deck.push(`${suit}-${rank}`);
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function dealInitialCards(table, deck) {
    table.dealer.cards = [];
    table.dealer.score = 0;
    
    // Yalnızca bahis yapan oyunculara kart dağıt
    const bettingPlayers = Object.keys(table.players).filter(userId => table.players[userId].bet > 0);

    bettingPlayers.forEach(userId => {
        table.players[userId].cards = [];
        table.players[userId].score = 0;
        table.players[userId].isStanding = false;
    });

    for (let i = 0; i < 2; i++) {
        table.dealer.cards.push(deck.pop());
        bettingPlayers.forEach(userId => {
            table.players[userId].cards.push(deck.pop());
        });
    }

    table.dealer.score = calculateScore(table.dealer.cards);
    bettingPlayers.forEach(userId => {
        table.players[userId].score = calculateScore(table.players[userId].cards);
    });

    table.currentPlayerIndex = 0;
    table.currentDeck = deck;
}


// --- OYUN SONRASI/SIRA YÖNETİMİ FONKSİYONLARI ---

/** Krupiye oynama mantığı ve Tur sonu hesaplama */
async function dealerPlay(table, channel) {
    // Mesajları temizlik için kaydet
    channel.send('🤖 **KRUPİYE OYNUYOR...** (Gizli kart açıldı)').then(m => table.lastRoundMessageIds.push(m.id));

    table.dealer.score = calculateScore(table.dealer.cards);
    await setupBlackjackTable(channel); 

    while (table.dealer.score < 17) {
        await new Promise(res => setTimeout(res, 1500)); 
        
        const newCard = table.currentDeck.pop();
        table.dealer.cards.push(newCard);
        table.dealer.score = calculateScore(table.dealer.cards);

        channel.send(`Krupiye çekti: ${newCard}. Yeni Puan: **${table.dealer.score}**`).then(m => table.lastRoundMessageIds.push(m.id));
        await setupBlackjackTable(channel); 
    }

    // --- TUR SONUÇLANDIRMA ---
    table.status = 'ROUND_OVER';
    await calculateWinnings(table, channel); 
    await setupBlackjackTable(channel); 
}

/** Sırayı sonraki oyuncuya geçirir veya krupiye sırasını başlatır */
async function nextTurn(table, channel) {
    // Sadece bahis yapmış ve elenmemiş oyuncular arasında dolaş
    const playersIdArray = Object.keys(table.players).filter(id => table.players[id].bet > 0);
    const playerCount = playersIdArray.length;

    let currentIndex = table.currentPlayerIndex; 
    let nextIndex = currentIndex;

    let foundNextPlayer = false;
    for (let i = 0; i < playerCount; i++) {
        nextIndex = (nextIndex + 1) % playerCount; 
        const nextPlayer = table.players[playersIdArray[nextIndex]];

        if (nextPlayer && nextPlayer.bet > 0 && !nextPlayer.isStanding && nextPlayer.score < 21) {
            table.currentPlayerIndex = nextIndex;
            foundNextPlayer = true;
            break;
        }
        
        if (nextIndex === currentIndex) break; 
    }

    if (foundNextPlayer) {
        await setupBlackjackTable(channel);
        // Mesajları temizlik için kaydet
        channel.send(`➡️ **SIRA:** <@${playersIdArray[table.currentPlayerIndex]}>!`).then(m => table.lastRoundMessageIds.push(m.id));
    } else {
        table.status = 'DEALER_TURN';
        table.currentPlayerIndex = -1; 
        await setupBlackjackTable(channel);
        await dealerPlay(table, channel);
    }
}


/** Kazananları hesapla ve paraları dağıt */
async function calculateWinnings(table, channel) {
    let results = [];
    const dealerScore = table.dealer.score;
    const dealerBust = dealerScore > 21;

    for (const userId in table.players) {
        const player = table.players[userId];
        if (player.bet === 0) continue; 
        
        const playerScore = player.score;
        const bet = player.bet;
        let winAmount = 0;
        let resultText = '';
        
        const userData = await getUserData(userId); 

        // 1. Oyuncu Bust oldu
        if (playerScore > 21) {
            resultText = '💥 Bust! Kaybettiniz.';
        
        // 2. Oyuncu BlackJack
        } else if (playerScore === 21 && player.cards.length === 2) {
            if (dealerScore === 21 && table.dealer.cards.length === 2) {
                winAmount = bet; 
                resultText = '👑 BlackJack ve Krupiye BlackJack! (Push)';
            } else {
                winAmount = bet * 2.5; 
                resultText = '👑 BlackJack! Kazandınız! (1.5x)';
            }
        
        // 3. Krupiye Bust oldu
        } else if (dealerBust) {
            winAmount = bet * 2; 
            resultText = '✅ Krupiye Bust oldu! Kazandınız.';
        
        // 4. Krupiyeden Yüksek Puan
        } else if (playerScore > dealerScore) {
            winAmount = bet * 2; 
            resultText = '✅ Krupiyeden yüksek puan! Kazandınız.';

        // 5. Berabere (Push)
        } else if (playerScore === dealerScore) {
            winAmount = bet; 
            resultText = '🤝 Berabere (Push). Bahis iade edildi.';
        
        // 6. Krupiye Kaybetti
        } else {
            resultText = '❌ Krupiye kazandı. Kaybettiniz.';
            winAmount = 0;
        }
        
        // Parayı ekle
        userData.money += Math.round(winAmount); 
        await userData.save();
        
        results.push(`**<@${userId}>** (${playerScore}): ${resultText} (${Math.round(winAmount - bet)} 💰 Net)`);
    }

    // Sonuç mesajını kanala gönder ve temizlik için kaydet
    const finalEmbed = new EmbedBuilder()
        .setColor('Blurple')
        .setTitle('✅ TUR SONUÇLANDI')
        .setDescription(`**Krupiye Final Puanı:** ${dealerScore} [${table.dealer.cards.join(' ')}]\n\n${results.join('\n')}`);
        
    channel.send({ embeds: [finalEmbed] })
        .then(m => table.lastRoundMessageIds.push(m.id));
        
    // --- LOBİ'YE GERİ DÖNÜŞ MANTIĞI (Otomatik Yeniden Başlatma) ---
    setTimeout(() => {
        // Bahisleri sıfırla, noBetCount'u kontrol et
        Object.keys(table.players).forEach(userId => {
            const p = table.players[userId];
            
            // Eğer bu el bahis yapmadıysa sayacı artır, yaptıysa sıfırla
            if (p.bet === 0) {
                 p.noBetCount = (p.noBetCount || 0) + 1; 
            } else {
                 p.noBetCount = 0; 
            }

            p.cards = [];
            p.score = 0;
            p.isStanding = false;
            p.bet = 0; 
        });

        table.status = 'LOBBY';
        table.dealer = { cards: [], score: 0 };
        table.currentDeck = [];
        table.currentPlayerIndex = 0;

        setupBlackjackTable(channel);
        channel.send(`🎲 Yeni el için bahisler açıldı! ${AUTO_START_DELAY_MS / 1000} saniye içinde \`${config.prefix || 'x!'}blackjack-bahis [miktar]\` ile bahsinizi yapın.`).then(m => table.lastRoundMessageIds.push(m.id));

    }, 5000); // 5 saniye sonra lobiye dön ve sayacı başlat
}


// --- BLACKJACK MASA KURULUM FONKSİYONU ---
async function setupBlackjackTable(channel) {
    const table = global.blackjackTable;
    
    // Yalnızca masada oturanları listeleyin
    const playerEntries = Object.keys(table.players);
    // Sıradaki oyuncuyu bul (sadece bahis yapmış olanlar döngüye girer, ama mesajda tüm oturanlar gözükmeli)
    const bettingPlayers = Object.keys(table.players).filter(id => table.players[id].bet > 0);
    const currentPlayerId = bettingPlayers[table.currentPlayerIndex];
    
    let playerList = '';

    // --- KRUPİYE BİLGİSİ ---
    let dealerCardsDisplay = 'Gizli Kart 🎴';
    let dealerScoreDisplay = '?';

    if (table.status !== 'LOBBY' && table.status !== 'ROUND_OVER' && table.dealer.cards.length > 0) {
        const firstCard = table.dealer.cards[0];
        dealerCardsDisplay = `${firstCard} 🎴 (+1 Kart Gizli)`;
    }
    if (table.status === 'DEALER_TURN' || table.status === 'ROUND_OVER') {
        dealerCardsDisplay = table.dealer.cards.join(' ');
        dealerScoreDisplay = table.dealer.score;
    }
    
    // --- OYUNCU LİSTESİ VE DURUMU ---
    for (let i = 0; i < MAX_PLAYERS; i++) {
        const playerId = playerEntries[i];
        if (playerId) {
            const player = table.players[playerId];
            const isTurn = playerId === currentPlayerId && table.status === 'IN_GAME';
            
            let statusEmoji;
            if (player.bet === 0 && table.status === 'LOBBY') {
                statusEmoji = `🕒 Bahis Bekleniyor (${player.noBetCount}/${MAX_NO_BET_ROUNDS})`;
            } else if (player.score > 21) statusEmoji = '💥 Bust!';
            else if (player.score === 21 && player.cards.length === 2) statusEmoji = '👑 Blackjack!';
            else if (player.isStanding) statusEmoji = '🛑 Durdu';
            else if (isTurn) statusEmoji = '➡️ Sırada';
            else statusEmoji = '✅ Beklemede';
            
            const cardsDisplay = player.cards.length > 0 ? `[${player.cards.join(' ')}] (${player.score})` : '';

            playerList += 
                `${i + 1}. <@${playerId}>: **${player.bet.toLocaleString()} 💰** ${cardsDisplay}\n` +
                `   *Durum:* ${statusEmoji}\n`;
        } else {
            playerList += `🪑 Koltuk ${i + 1}: Boş\n`;
        }
    }
    
    // Lobi durumunda geri sayım gösterimi
    let statusDesc = table.status === 'LOBBY' 
        ? (Object.keys(table.players).filter(id => table.players[id].bet > 0).length > 0 
            ? `⏱️ OYUN: ${countdown} saniye içinde başlıyor!` 
            : 'Lobi (Bahisler Bekleniyor)')
        : table.status === 'IN_GAME' 
            ? `🔥 OYUN: <@${currentPlayerId}> Sırada` 
            : table.status === 'DEALER_TURN' 
                ? '🤖 Krupiye Oynuyor' 
                : '✅ TUR SONU';


    const embed = new EmbedBuilder()
        .setColor(table.status === 'ROUND_OVER' ? 'Red' : 'DarkGreen')
        .setTitle('♠️ Blackjack Masası (21)')
        .setDescription(`**KRUPİYE:** ${dealerCardsDisplay} (Puan: ${dealerScoreDisplay})\n---\n**MASA DURUMU:** ${statusDesc}\n\n${playerList}`)
        .setFooter({ text: `Maksimum ${MAX_PLAYERS} oyuncu. Bot ID: ${client.user.id}` });


    let actionRows = [];
    
    // 1. LOBİ BUTONLARI (Join/Leave)
    const lobbyRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('bj_join')
                .setLabel('Masaya Katıl')
                .setStyle(ButtonStyle.Success)
                .setDisabled(playerEntries.length >= MAX_PLAYERS || table.status !== 'LOBBY'),
            new ButtonBuilder()
                .setCustomId('bj_leave')
                .setLabel('Masadan Ayrıl')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(table.status !== 'LOBBY') 
        );
    actionRows.push(lobbyRow);

    // 2. OYUN İÇİ BUTONLARI (Hit/Stand)
    if (table.status === 'IN_GAME' && currentPlayerId) {
        const player = table.players[currentPlayerId];
        const gameRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('bj_hit')
                    .setLabel('Vur (Hit)')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(player?.isStanding || player?.score >= 21),
                new ButtonBuilder()
                    .setCustomId('bj_stand')
                    .setLabel('Dur (Stand)')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(player?.isStanding)
            );
        actionRows.push(gameRow);
    }
    
    // TUR BİTİŞ BUTONU KALDIRILDI

    try {
        if (table.messageId) {
            const message = await channel.messages.fetch(table.messageId);
            await message.edit({ embeds: [embed], components: actionRows });
        } else {
            const message = await channel.send({ embeds: [embed], components: actionRows });
            table.messageId = message.id;
        }
    } catch (error) {
        console.error("Blackjack masa mesajı gönderilemedi/güncellenemedi:", error);
    }
}


// --- OYUN OTOMASYON MANTIĞI ---

let countdown = AUTO_START_DELAY_MS / 1000;
let bjTimer = null;

/** Otomatik el başlatma, oyuncu atma ve temizlik mantığı */
async function handleBlackjackAutomation(channel) {
    const table = global.blackjackTable;

    // 1. Tur sonuçlarını temizle (Lobby'ye geçerken)
    if (table.status === 'LOBBY' && table.lastRoundMessageIds.length > 0) {
        // Tüm mesajları sil
        const messagesToDelete = table.lastRoundMessageIds.map(id => channel.messages.fetch(id).catch(() => null));
        await Promise.all(messagesToDelete)
            .then(messages => messages.forEach(m => m?.delete().catch(() => {})))
            .catch(() => {});
            
        table.lastRoundMessageIds = []; 
    }

    // 2. Lobi durumunda otomatik başlatma sayacı
    if (table.status === 'LOBBY') {
        const activePlayers = Object.keys(table.players).length;
        const betPlayers = Object.values(table.players).filter(p => p.bet > 0).length;

        if (activePlayers >= 1 && betPlayers >= 1) {
            countdown--;
        } else {
            countdown = AUTO_START_DELAY_MS / 1000; 
        }

        // Masayı güncelleyerek kalan süreyi göster (Her saniye)
        await setupBlackjackTable(channel); 
        
        // OYUN BAŞLATMA ZAMANI
        if (countdown <= 0) {
            countdown = AUTO_START_DELAY_MS / 1000; 
            await startBlackjackRound(table, channel);
            return;
        }
    }
}

/** Otomatik başlatma ve oyuncu atma mantığını içerir */
async function startBlackjackRound(table, channel) {
    
    // --- OYUNCU ATMA MANTIĞI ---
    const playersToKick = [];
    for (const userId in table.players) {
        const player = table.players[userId];
        if (player.noBetCount >= MAX_NO_BET_ROUNDS) {
            playersToKick.push(userId);
        }
    }

    playersToKick.forEach(userId => {
        delete table.players[userId];
        channel.send(`👋 <@${userId}>, **${MAX_NO_BET_ROUNDS}** el boyunca bahis yapmadığınız için masadan atıldınız.`).then(m => table.lastRoundMessageIds.push(m.id));
    });

    const activePlayersAfterKick = Object.keys(table.players).length;
    const betPlayers = Object.values(table.players).filter(p => p.bet > 0).length;

    if (activePlayersAfterKick === 0 || betPlayers === 0) {
        // Bahis yapacak kimse kalmadıysa lobiye dön
        table.status = 'LOBBY';
        return setupBlackjackTable(channel); 
    }


    // --- OYUN BAŞLATMA MANTIĞI ---
    table.status = 'IN_GAME';
    
    const deck = createAndShuffleDeck(); 
    dealInitialCards(table, deck); 
    
    await setupBlackjackTable(channel);

    channel.send('🔥 **Oyun Başladı!** Kartlar dağıtıldı. Lütfen sıranızı bekleyin ve butonları kullanın.').then(m => table.lastRoundMessageIds.push(m.id));
    
    // İlk oyuncu BlackJack yaptıysa sırayı geçir
    const playersIdArray = Object.keys(table.players).filter(id => table.players[id].bet > 0);
    const firstPlayerId = playersIdArray[0];
    const firstPlayer = table.players[firstPlayerId];
    
    if (firstPlayer.score === 21 && firstPlayer.cards.length === 2) {
        firstPlayer.isStanding = true; 
        channel.send(`👑 <@${firstPlayerId}> **BlackJack** yaptı ve duruyor!`).then(m => table.lastRoundMessageIds.push(m.id));
        await nextTurn(table, channel);
    }
}


// --- KOMUT YÜKLEYİCİ ---

client.commands = new Map();

const commandsPath = path.join(__dirname, 'commands'); 
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    import(`file://${filePath}`).then(module => {
        const command = module.default; 
        
        client.commands.set(command.name, command);
        
        if (command.aliases) {
            command.aliases.forEach(alias => client.commands.set(alias, command));
        }
        console.log(`Komut yüklendi: ${command.name}`);
    }).catch(error => {
        console.error(`Komut yüklenirken hata oluştu: ${file}`, error);
    });
}

// --- BOT OLAYLARI ---

client.on('ready', async () => {
    console.log(`🤖 Bot hazır: ${client.user.tag}`);

    // --- BLACKJACK MASA KURULUMU VE OTO-BAŞLATMA BAŞLAT ---
    const bjChannel = client.channels.cache.get(BLACKJACK_CHANNEL_ID);
    if (bjChannel) {
        await setupBlackjackTable(bjChannel); 
        
        if (!bjTimer) {
             bjTimer = setInterval(() => handleBlackjackAutomation(bjChannel), 1000); 
        }
    }
    // --- BLACKJACK MASA KURULUMU SONU ---


    // ... (Aktivite Güncelleme Kodu) ...
    const updateActivity = () => {
        const activities = [
            { 
                name: `Xarso Bet - ${config.prefix}yardim`, 
                type: 0
            }, 
            { 
                name: `Sizleri`, 
                type: 2
            },
            {
                name: `${client.guilds.cache.size} sunucuyu yönetiyor`,
                type: 0 
            }
        ];
        
        const activity = activities[Math.floor(Math.random() * activities.length)];
        
        client.user.setPresence({
            activities: [activity],
            status: 'online',
        });
    };

    updateActivity();
    setInterval(updateActivity, 60000); 
});

// ==========================================================
// 1. MESAJ KOMUTLARI & XP KAZANMA
// ==========================================================
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    // --- XP KAZANMA VE SEVİYE YÜKSELTME MANTIĞI ---
    const userData = await getUserData(msg.author.id);
    const now = Date.now();
    const cooldown = config.xp_cooldown_ms; 

    if (!userData.lastXPGain || (now - userData.lastXPGain.getTime() > cooldown)) {
        
        const xpGained = Math.floor(Math.random() * 11) + 15;
        userData.xp += xpGained;
        userData.lastXPGain = new Date(now);

        const MAX_LEVEL = 100;
        
        while (userData.level < MAX_LEVEL) {
            const requiredXP = calculateXPForLevel(userData.level);
            
            if (userData.xp >= requiredXP) {
                userData.xp -= requiredXP;
                userData.level++;
                msg.channel.send(`🎉 Tebrikler ${msg.author}! **Seviye ${userData.level}**'a ulaştın!`);
            } else {
                break;
            }
        }
        await userData.save();
    }
    // --- XP MANTIĞI SONU ---
    
    if (!msg.content.startsWith(config.prefix)) return;

    const args = msg.content.slice(config.prefix.length).trim().split(/ +/g);
    const cmd = args.shift().toLowerCase();
    const command = client.commands.get(cmd) ||
        Array.from(client.commands.values()).find(c => c.aliases && c.aliases.includes(cmd));

    // Eğer komut yoksa, erken sonlandır
    if (!command) return;

    // Bütün işlemler tek bir if (command) bloğu içinde olacak.
    // DÜELLO KONTROLÜ
    if (command.name === 'rulet-duel' || command.aliases?.includes('rduel')) {
        if (ACTIVE_RULET_DUELS.has(msg.author.id)) {
            msg.reply('❌ Zaten aktif bir rulet düellosunun parçasısınız.').catch(() => { });
            return; // Bu, messageCreate callback'ini sonlandırır.
        }
    }

    if (command) {
        try {
            // Tower ve Blackjack komutları için gerekli fonksiyonlar buraya eklendi.
            await command.execute(msg, args, config, User, GiftCode, TICKET_COOLDOWN_MS, formatTime, getUserData, calculateScore, createAndShuffleDeck, dealInitialCards, setupBlackjackTable, nextTurn); 
        } catch (error) {
            console.error(`Komut çalışırken hata oluştu (${cmd}):`, error);
            msg.reply('Komutu çalıştırırken bir hata oluştu.');
        }
    }
});

// ==========================================================
// 2. İNTERAKSİYON (Buton/Modal) Dinleyicisi
// ==========================================================
client.on('interactionCreate', async (interaction) => {
    
    const { customId, channel, user } = interaction;
    const userId = interaction.user.id;

    const isRouletteHandled = await handleRouletteInteractions(interaction, getUserData);
    if (isRouletteHandled) return;
    // ==========================================================
    // D. TOWER BUTONLARI
    // ==========================================================
    if (interaction.isButton() && customId.startsWith('tower_')) {
        const currentGames = global.towerGames;
        const game = currentGames[userId];

        await interaction.deferReply({ ephemeral: true });

        if (!game || !game.isPlaying) {
            return interaction.editReply('❌ Devam eden bir kule oyununuz yok.');
        }
        
        if (interaction.message.id !== game.messageId) {
             return interaction.editReply('❌ Bu buton eski bir oyuna ait. Lütfen aktif mesajı kullanın.');
        }

        // --- NAKİT ÇEKME (CASH OUT) ---
        if (customId === 'tower_cashout') {
            if (game.stage === 0) {
                 return interaction.editReply('❌ Henüz hiç kapı açmadınız!');
            }
            
            if (game.isCashout) {
                 return interaction.editReply('❌ Zaten nakit çektiniz!');
            }

            const winnings = Math.round(game.bet * game.currentMultiplier);
            const userData = await getUserData(userId);
            
            userData.money += winnings; 
            await userData.save();

            game.isPlaying = false;
            game.isCashout = true;
            delete currentGames[userId]; 

            const { embed, components } = createTowerEmbed(game, userId, 'win'); 
            await interaction.message.edit({ embeds: [embed], components: components }).catch(console.error);
            
            return interaction.editReply(`✅ **NAKİT ÇEKİLDİ!** ${game.currentMultiplier.toFixed(2)}× çarpanla **${winnings.toLocaleString()} 💰** kazandınız!`);

        // --- KAPI SEÇME ---
        } else if (customId.startsWith('tower_select_')) {
            const choice = parseInt(customId.split('_')[2]);
            const configMode = MODE_CONFIG[game.mode];
            const maxStage = MAX_STAGES[game.mode];

            if (game.isCashout) return interaction.editReply('❌ Oyun zaten bitti.');

            game.lastChoice = choice;

            // KAYIP DURUMU
            if (game.wrongDoor.includes(choice)) {
                
                game.isPlaying = false;
                delete currentGames[userId]; 

                const { embed, components } = createTowerEmbed(game, userId, 'lose');
                await interaction.message.edit({ embeds: [embed], components: components }).catch(console.error);
                
                return interaction.editReply(`💥 **BOOM!** Yanlış kapıyı seçtiniz. **${game.bet.toLocaleString()} 💰** bahsiniz yandı. Kazanç: 0 💰`);

            // KAZANÇ DURUMU
            } else {
                
                // Bir sonraki aşamaya geç
                const nextStage = game.stage + 1;
                
                if (nextStage >= maxStage) {
                    // Maksimum aşamaya ulaşıldı
                    const finalMultiplier = TOWER_MULTIPLIERS[game.mode][nextStage - 1];
                    const winnings = Math.round(game.bet * finalMultiplier);
                    const userData = await getUserData(userId);
                    
                    userData.money += winnings;
                    await userData.save();
                    
                    game.currentMultiplier = finalMultiplier;
                    game.isPlaying = false;
                    game.isCashout = true;
                    delete currentGames[userId]; 
                    
                    const { embed, components } = createTowerEmbed(game, userId, 'win');
                    await interaction.message.edit({ embeds: [embed], components: components }).catch(console.error);

                    return interaction.editReply(`🏆 **MAKSİMUM SEVİYE!** Tüm kuleyi tamamladınız! Toplam **${winnings.toLocaleString()} 💰** kazandınız!`);
                
                } else {
                    // Yeni aşamaya geç
                    game.currentMultiplier = TOWER_MULTIPLIERS[game.mode][nextStage];
                    game.stage = nextStage;
                    game.wrongDoor = getRandomWrongDoor(configMode.doors, configMode.wrong); 

                    const { embed, components } = createTowerEmbed(game, userId);
                    await interaction.message.edit({ embeds: [embed], components: components }).catch(console.error);

                    return interaction.editReply(`✅ Kapı ${choice} doğruydu! Yeni çarpan: **${game.currentMultiplier.toFixed(2)}×**. Bir sonraki kapıyı seçin.`);
                }
            }
        }
        return; 
    }

    // ==========================================================
    // C. BLACKJACK BUTONLARI
    // ==========================================================
    if (interaction.isButton() && customId.startsWith('bj_')) {
        const table = global.blackjackTable;
        
        if (channel.id !== BLACKJACK_CHANNEL_ID) return;

        await interaction.deferReply({ ephemeral: true });

        if (customId === 'bj_join') {
            
            if (table.players[userId]) return interaction.editReply('❌ Zaten masadasınız!');
            if (Object.keys(table.players).length >= MAX_PLAYERS) return interaction.editReply('❌ Masa dolu!');
            if (table.status !== 'LOBBY') return interaction.editReply('❌ Oyun devam ediyor, lobiye dönünce katılabilirsiniz.');
            
            // noBetCount: 0 olarak ekle
            table.players[userId] = { bet: 0, cards: [], score: 0, isStanding: false, noBetCount: 0 }; 
            await setupBlackjackTable(channel); 
            
            return interaction.editReply(`✅ Masaya oturdunuz. Şimdi \`${config.prefix || 'x!'}blackjack-bahis [miktar]\` ile bahsinizi yapın.`);

        } else if (customId === 'bj_leave') {
            
            if (!table.players[userId]) return interaction.editReply('❌ Zaten masada değilsiniz.');
            if (table.status !== 'LOBBY') return interaction.editReply('❌ Oyun devam ediyor, eliniz bitmeden ayrılamazsınız!');

            delete table.players[userId];
            await setupBlackjackTable(channel); 
            return interaction.editReply('🚶 Masadan ayrıldınız.');

        } else if (customId === 'bj_hit' || customId === 'bj_stand') {
            
            if (table.status !== 'IN_GAME') return interaction.editReply('❌ Şu an oyun dönemi değil.');

            const playersIdArray = Object.keys(table.players).filter(id => table.players[id].bet > 0);
            const currentPlayerId = playersIdArray[table.currentPlayerIndex];
            
            if (userId !== currentPlayerId) return interaction.editReply('❌ Sizin sıranız değil!');

            const player = table.players[userId];
            
            if (customId === 'bj_hit') {
                const newCard = table.currentDeck.pop();
                player.cards.push(newCard);
                player.score = calculateScore(player.cards);
                
                if (player.score >= 21) {
                    player.isStanding = true; 
                    await setupBlackjackTable(channel);
                    await interaction.editReply(`💥 Yeni kart: ${newCard}. Puanınız: **${player.score}**. Sıra geçti.`);
                    
                    await nextTurn(table, channel);
                    
                } else {
                    await setupBlackjackTable(channel);
                    return interaction.editReply(`✅ Yeni kart: ${newCard}. Puanınız: **${player.score}**. Devam edebilirsiniz.`);
                }
            
            } else if (customId === 'bj_stand') {
                
                player.isStanding = true;
                await setupBlackjackTable(channel);
                await interaction.editReply('🛑 Kart çekmeyi bıraktınız. Sıra geçti.');
                
                await nextTurn(table, channel);
            }
        
        } 

        return; 
    }
    // ... (Rain ve Ticket mantıkları burada devam eder) ...
    // ==========================================================
    // A. RAIN (YAĞMUR) SİSTEMİ ETKİLEŞİMLERİ (Önceki Kodunuz)
    // ==========================================================
    const rainData = client.currentRain;
    
    if (rainData && rainData.isActive && customId.startsWith('rain_')) {
        
        if (interaction.isButton() && customId === 'rain_join') {
            await interaction.deferReply({ ephemeral: true });

            const userData = await getUserData(interaction.user.id);
            
            if (userData.level < rainData.minLevel) {
                return interaction.editReply(`❌ Katılmak için minimum **Seviye ${rainData.minLevel}** olmalısınız. Mevcut seviyeniz: ${userData.level}.`);
            }

            if (rainData.participants.has(interaction.user.id)) {
                return interaction.editReply('❌ Zaten Rain etkinliğine katıldınız!');
            }

            if (rainData.participants.size >= rainData.maxWinners) {
                 return interaction.editReply('⚠️ Maalesef, maksimum katılımcı sayısına ulaşıldı!');
            }
            
            rainData.participants.add(interaction.user.id);
            
            const originalMessage = await interaction.channel.messages.fetch(rainData.messageId).catch(() => null);
            
            if (originalMessage && originalMessage.embeds.length > 0) {
                const existingEmbed = originalMessage.embeds[0];
                const newEmbed = EmbedBuilder.from(existingEmbed);

                let participantField = newEmbed.data.fields?.find(f => f.name.includes('Katılımcı Sayısı'));
                
                if (participantField) {
                     participantField.value = `${rainData.participants.size}`;
                } else {
                     newEmbed.addFields({ name: '✅ Katılımcı Sayısı', value: `${rainData.participants.size}`, inline: true });
                }
                
                await originalMessage.edit({ embeds: [newEmbed] }).catch(console.error);
            }

            return interaction.editReply(`✅ Başarıyla **${rainData.rainName}** etkinliğine katıldınız!`);
        }

        if (interaction.isButton() && customId === 'rain_donate_open') {
            const DONATE_MODAL_ID = 'rain_donate_modal';
            const modal = new ModalBuilder()
                .setCustomId(DONATE_MODAL_ID)
                .setTitle(`${rainData.rainName} Bağış Ekleyin`);

            const amountInput = new TextInputBuilder()
                .setCustomId('donation_amount')
                .setLabel('Kaç 💰 bağışlamak istiyorsunuz?')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Örn: 5000')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
            return interaction.showModal(modal);
        }
        
        if (interaction.isModalSubmit() && customId === 'rain_donate_modal') {
            await interaction.deferReply({ ephemeral: true });
            
            const amountStr = interaction.fields.getTextInputValue('donation_amount');
            const amount = parseInt(amountStr);
            const userId = interaction.user.id;

            if (isNaN(amount) || amount <= 0) {
                return interaction.editReply('❌ Bağış miktarı pozitif bir sayı olmalıdır.');
            }

            const userData = await getUserData(userId);

            if (userData.money < amount) {
                return interaction.editReply(`❌ Yeterli bakiyeniz yok. Mevcut: ${userData.money.toLocaleString()} 💰`);
            }

            userData.money -= amount;
            await userData.save();
            
            rainData.totalPrize += amount;
            const currentDonation = rainData.donorUsers.get(userId) || 0;
            rainData.donorUsers.set(userId, currentDonation + amount);

            const originalMessage = await interaction.channel.messages.fetch(rainData.messageId).catch(() => null);
            
            if (originalMessage && originalMessage.embeds.length > 0) {
                const existingEmbed = originalMessage.embeds[0];
                const newEmbed = EmbedBuilder.from(existingEmbed);
                
                let prizeField = newEmbed.data.fields?.find(f => f.name.includes('Toplam Ödül Havuzu'));
                if (prizeField) {
                     prizeField.value = `${rainData.totalPrize.toLocaleString()} 💰`;
                } else {
                     newEmbed.addFields({ name: '💰 Toplam Ödül Havuzu', value: `${rainData.totalPrize.toLocaleString()} 💰`, inline: true });
                }

                const sortedDonors = Array.from(rainData.donorUsers.entries())
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 3);
                
                const donorList = sortedDonors.length > 0 
                    ? sortedDonors.map(([id, donorAmount], index) => 
                        `${index + 1}. <@${id}> - ${donorAmount.toLocaleString()} 💰`
                      ).join('\n')
                    : "Henüz bağış yapılmadı.";
                
                let donorField = newEmbed.data.fields?.find(f => f.name.includes('En Çok Bağış Yapanlar')); 
                if (donorField) {
                    donorField.value = donorList;
                } else {
                     newEmbed.addFields({ name: '❤️ En Çok Bağış Yapanlar', value: donorList, inline: false });
                }
                
                await originalMessage.edit({ embeds: [newEmbed] }).catch(console.error);
            }
            
            return interaction.editReply(`✅ Başarıyla **${amount.toLocaleString()} 💰** bağışladınız! Yeni ödül: ${rainData.totalPrize.toLocaleString()} 💰`);
        }
        
        return; 
    }
    
    // ==========================================================
    // B. TICKET BUTONLARI (Önceki Kodunuz)
    // ==========================================================
    if (!interaction.isButton()) return;
    
    if (!customId.startsWith('withdraw_') && !customId.startsWith('deposit_')) {
        return; 
    }
    
    if (!interaction.member.roles.cache.has(config.modRoleID)) {
        return interaction.reply({ content: '❌ Bu işlemi sadece yetkili yöneticiler gerçekleştirebilir.', ephemeral: true });
    }
    
    try {
        await interaction.deferReply({ ephemeral: true });
    } catch (err) {
        if (err.code === 10062) {
            console.log(`[INFO] Etkileşim zaman aşımı nedeniyle işlem atlandı: ${customId}`);
            return; 
        }
        console.error('Defer Reply Hatası:', err);
        return;
    }

    const originalEmbed = interaction.message.embeds[0];
    const userIdField = originalEmbed?.fields.find(f => f.name === 'Talep Sahibi');
    const amountField = originalEmbed?.fields.find(f => f.name.includes('Miktar'));
    
    if (!userIdField || !amountField) {
         return interaction.editReply({ content: '❌ Embed üzerinde kullanıcı ID veya miktar bulunamadı.' });
    }
    
    const requesterIdMatch = userIdField.value.match(/\`(\d+)\`/);
    const requesterId = requesterIdMatch ? requesterIdMatch[1] : null; 
    
    const amountStr = amountField.value.replace(/[^0-9]/g, ''); 
    const amount = parseInt(amountStr);

    if (!requesterId || isNaN(amount) || amount <= 0) {
        return interaction.editReply({ content: '❌ Hatalı veri okuması. (Kullanıcı ID veya Miktar).' });
    }
    
    const closeChannel = (closeMessage) => {
        channel.send(closeMessage).catch(e => console.error("Kapanış mesajı gönderilemedi:", e));
        
        setTimeout(() => {
            channel.delete().catch(err => {
                if (err.code === 10003) {
                    console.log(`[INFO] Kanal silme işlemi atlandı. Kanal (${channel.id}) zaten bulunamadı/silinmiş.`);
                } else {
                    console.error("Kanal kapatma hatası (İzin Sorunu Olabilir):", err);
                }
            });
        }, CLOSE_DELAY_MS);
    };

    // --- Ticket Mantığı (Deposit, Withdraw) devam eder ---
    if (customId === 'deposit_approve') {
        await User.updateOne({ userId: requesterId }, { $inc: { money: amount } }, { upsert: true });
        try {
            const requester = await client.users.fetch(requesterId);
            await requester.send(`✅ **Yükleme Onayı:** Yönetici (${user.tag}) tarafından **${amount.toLocaleString()}** 💰 bakiyeniz hesabınıza başarıyla yüklendi.`);
        } catch (e) {
            console.error(`DM gönderilemedi: ${requesterId}`, e);
        }
        await interaction.editReply({ content: `✅ Deposit işlemi tamamlandı. ${amount.toLocaleString()} 💰 yüklendi.` });
        closeChannel(`✅ TALEP ONAYLANDI: ${user} tarafından **${amount.toLocaleString()}** 💰 yüklendi. Kanal ${CLOSE_DELAY_MS / 1000} saniye içinde kapatılacaktır.`);
    
    } else if (customId === 'deposit_fail') {
        const reasonPrompt = await interaction.followUp({
            content: `❌ YÜKLEME BAŞARISIZ: Lütfen bu kararın nedenini **tek bir mesajda** yazın.`,
            ephemeral: true
        });

        const filter = m => m.author.id === user.id && m.channel.id === channel.id;
        const collector = channel.createMessageCollector({ filter, max: 1, time: 60000 });

        collector.on('collect', async m => {
            const reason = m.content.substring(0, 150);
            try {
                const requester = await client.users.fetch(requesterId);
                await requester.send(`❌ **Yükleme Başarısız:** Yönetici (${user.tag}), yükleme talebinizi **reddetti**. Sebep: **${reason}**.`);
            } catch (e) {
                console.error(`DM gönderilemedi: ${requesterId}`, e);
            }
            await m.delete().catch(e => console.error("Sebep mesajı silinemedi:", e));
            await interaction.editReply({ content: `❌ Deposit iptal edildi. Sebep kullanıcıya DM olarak gönderildi.` });
            closeChannel(`❌ YÜKLEME BAŞARISIZ: ${user} tarafından reddedildi. Sebep: \`${reason}\`. Kanal ${CLOSE_DELAY_MS / 1000} saniye içinde kapatılacaktır.`);
        });

        collector.on('end', async (collected) => {
            if (collected.size === 0) {
                await channel.send('❌ Sebep girilmediği için ticket manuel kapatılmalıdır.').catch(() => {});
                await interaction.editReply({ content: 'Sebep girme süresi doldu. Ticket manuel kapatılmalıdır.' });
            }
        });
    } else if (customId === 'withdraw_refund') { 
        await User.updateOne({ userId: requesterId }, { $inc: { money: amount } }, { upsert: true });
        try {
            const requester = await client.users.fetch(requesterId);
            await requester.send(`⚠️ **Çekim İptali (İade Edildi):** Yönetici (${user.tag}), çekim işleminin tamamlanamadığını belirterek **${amount.toLocaleString()}** 💰 bakiyenizi hesabınıza iade etti.`);
        } catch (e) {
            console.error(`DM gönderilemedi: ${requesterId}`, e);
        }
        await interaction.editReply({ content: `⚠️ Çekim iptal edildi. ${amount.toLocaleString()} 💰 kullanıcıya iade edildi.` });
        closeChannel(`⚠️ ÇEKİM İPTAL EDİLDİ (İADE): ${user} tarafından **${amount.toLocaleString()}** 💰 iade edildi. Kanal ${CLOSE_DELAY_MS / 1000} saniye içinde kapatılacaktır.`);
    } else if (customId === 'withdraw_confirm') { 
        try {
            const requester = await client.users.fetch(requesterId);
            await requester.send(`✅ **Çekim Onaylandı:** Yönetici (${user.tag}) tarafından çekim işleminiz **başarıyla tamamlandı** ve ödemeniz yapıldı.`);
        } catch (e) {
            console.error(`DM gönderilemedi: ${requesterId}`, e);
        }
        await interaction.editReply({ content: `✅ Çekim onaylandı ve ödeme yapıldığı varsayıldı.` });
        closeChannel(`✅ ÇEKİM ONAYLANDI: ${user} tarafından ödeme tamamlandı. Kanal ${CLOSE_DELAY_MS / 1000} saniye içinde kapatılacaktır.`);
    } else if (customId === 'withdraw_burn') {
        const reasonPrompt = await interaction.followUp({
            content: `❌ ÇEKİM İPTALİ (PARA YANDI): Lütfen bu kararın nedenini **tek bir mesajda** yazın.`,
            ephemeral: true
        });

        const filter = m => m.author.id === user.id && m.channel.id === channel.id;
        const collector = channel.createMessageCollector({ filter, max: 1, time: 60000 });

        collector.on('collect', async m => {
            const reason = m.content.substring(0, 150);
            try {
                const requester = await client.users.fetch(requesterId);
                await requester.send(`❌ **Çekim İptali (Bakiye Yandı):** Yönetici (${user.tag}), çekim işleminizi **iptal etti** ve bakiye hesabınıza iade edilmedi. Sebep: **${reason}**.`);
            } catch (e) {
                console.error(`DM gönderilemedi: ${requesterId}`, e);
            }
            await m.delete().catch(e => console.error("Sebep mesajı silinemedi:", e));
            await interaction.editReply({ content: `❌ Çekim iptal edildi. Bakiye yandı. Sebep kullanıcıya DM olarak gönderildi.` });
            closeChannel(`❌ ÇEKİM İPTAL EDİLDİ (BAKİYE YANDI): ${user} tarafından iptal edildi. Sebep: \`${reason}\`. Kanal ${CLOSE_DELAY_MS / 1000} saniye içinde kapatılacaktır.`);
        });

        collector.on('end', async (collected) => {
            if (collected.size === 0) {
                await channel.send('❌ Sebep girilmediği için ticket manuel kapatılmalıdır.').catch(() => {});
                await interaction.editReply({ content: 'Sebep girme süresi doldu. Ticket manuel kapatılmalıdır.' });
            }
        });
    }

    await interaction.message.edit({ components: [] }).catch(() => {});
});


client.login(config.token);