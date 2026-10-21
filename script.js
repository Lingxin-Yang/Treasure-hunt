/* ============================================================
 * Argus-Cell 寻宝之旅 —— 交互式异步寻宝游戏
 * ------------------------------------------------------------
 * 本文件刻意不使用 Promise 的 then 链式调用，所有流程都用 async/await 表达：
 *
 *   1) delay(ms) 把 setTimeout 包装成 Promise；
 *   2) waitForUserChoice() 返回一个“悬而未决”的 Promise；
 *   3) 按钮 click 事件里调用 resolve(choice)，这个 Promise 才完成；
 *   4) await 之后的代码于是继续执行，主流程从头到尾像同步代码一样好读。
 *
 * 关键点：async 函数执行到 await 时会“暂停”（交还控制权），
 * 但不会阻塞浏览器 —— 玩家依然可以点击按钮、看到动画。
 * 点击发生时，事件循环调用 selectChoice()，而它手里握着
 * waitForUserChoice() 暴露出来的 resolve 函数，于是把选择结果送回主线。
 * ============================================================ */

'use strict';

/* ================= 1. 通用异步工具 ================= */

/**
 * 等待指定毫秒数。
 * setTimeout 本身是回调式的，这里用 Promise 包一层，
 * 就能在 async 函数里写成 `await delay(800)`。
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 用于取消上一轮冒险的异常类型 */
class RunCancelled extends Error {
    constructor() {
        super('上一轮冒险已取消');
        this.name = 'RunCancelled';
    }
}

/**
 * 游戏运行时状态。
 * choiceResolve / choiceReject 是连接“按钮点击”与“await 暂停点”的桥梁。
 */
const game = {
    runId: 0,             // 每开一局 +1，旧流程发现 runId 变化后自行退出
    choiceResolve: null,  // waitForUserChoice() 暴露出来的 resolve
    choiceReject: null,   // 重新开始时用来中断旧的等待
    locked: true,         // true 表示按钮不可点击
    running: false,       // 是否有一局正在进行
    stats: { startTime: 0, cleared: 0 },
};

// 记录本局已经通过的地点名称，用于右上角“已通过”标签（只追加，不预告未来）
const clearedNames = new Set();

/** 若当前流程已被新一局取代，就抛出异常，终止旧的 async 函数 */
function ensureActive(runId) {
    if (runId !== game.runId) {
        throw new RunCancelled();
    }
}

/**
 * 【核心机制】通用等待函数：返回一个 Promise，并把 resolve / reject 暂存起来。
 *
 * 调用方写：
 *     const choice = await waitForUserChoice();
 * 此时 async 函数会停在这一行，直到某个按钮的 click 事件
 * 调用 game.choiceResolve(choice)，Promise 才会完成，主流程继续往下走。
 *
 * 注意：这里没有回调嵌套，也没有 then()，控制权始终由 async 函数掌握。
 * @returns {Promise<object>} 玩家选中的选项对象
 */
function waitForUserChoice() {
    return new Promise((resolve, reject) => {
        game.choiceResolve = resolve;
        game.choiceReject = reject;
    });
}

/** 中断正在等待的 Promise（点击“重新开始”时调用） */
function cancelPendingChoice() {
    if (game.choiceReject) {
        const reject = game.choiceReject;
        game.choiceResolve = null;
        game.choiceReject = null;
        reject(new RunCancelled());
    }
}

/* ================= 2. DOM 引用与全局配置 ================= */

const els = {
    storyScroll: document.getElementById('storyScroll'),
    storyLog: document.getElementById('storyLog'),
    choices: document.getElementById('choices'),
    hint: document.getElementById('hint'),
    hintText: document.getElementById('hintText'),
    chapterLabel: document.getElementById('chapterLabel'),
    clearedList: document.getElementById('clearedList'),
    journey: document.getElementById('journey'),
    sceneProps: document.getElementById('sceneProps'),
    sceneIcon: document.getElementById('sceneIcon'),
    sceneCaption: document.getElementById('sceneCaption'),
    restartBtn: document.getElementById('restartBtn'),
    overlay: document.getElementById('overlay'),
    overlayCard: document.getElementById('overlayCard'),
    overlayIcon: document.getElementById('overlayIcon'),
    overlayTitle: document.getElementById('overlayTitle'),
    overlayText: document.getElementById('overlayText'),
    overlayStats: document.getElementById('overlayStats'),
    overlayBtn: document.getElementById('overlayBtn'),
    confetti: document.getElementById('confetti'),
    dust: document.getElementById('dust'),
};

// 系统开启“减少动态效果”时，跳过打字机逐字输出
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const TYPE_SPEED = REDUCED_MOTION ? 0 : 18;   // 每个字的间隔（毫秒）
const LINE_PAUSE = REDUCED_MOTION ? 0 : 180;  // 一行结束后的小停顿

/** 逐行输出剧情时，每次滚动的辅助函数 */
function scrollStoryToBottom() {
    els.storyScroll.scrollTop = els.storyScroll.scrollHeight;
}

/** 生成背景里缓慢漂浮的金色尘埃 */
function buildDust() {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 34; i += 1) {
        const dot = document.createElement('span');
        dot.style.left = `${(Math.random() * 100).toFixed(2)}%`;
        dot.style.top = `${(Math.random() * 100).toFixed(2)}%`;
        dot.style.opacity = (0.15 + Math.random() * 0.45).toFixed(2);
        dot.style.animationDelay = `${(-Math.random() * 8).toFixed(2)}s, ${(-Math.random() * 4).toFixed(2)}s`;
        dot.style.animationDuration = `${(7 + Math.random() * 7).toFixed(2)}s, ${(2.8 + Math.random() * 2).toFixed(2)}s`;
        fragment.appendChild(dot);
    }
    els.dust.appendChild(fragment);
}

/* ================= 3. HUD 与提示文字 ================= */

/** 更新“当前章节” */
function setChapter(text) {
    els.chapterLabel.textContent = text;
}

/** 清空“已通过”标签，恢复到只有占位文字的状态 */
function resetCleared() {
    clearedNames.clear();
    els.clearedList.innerHTML = '<span class="cleared-empty">尚无</span>';
}

/**
 * 追加一个已通过的地点。
 * 右上角只展示玩家真正完成过的关卡，不预告未来还有多少关。
 * @param {string} name 地点简称
 */
function markLevelCleared(name) {
    if (!name || clearedNames.has(name)) {
        return;
    }
    clearedNames.add(name);

    const empty = els.clearedList.querySelector('.cleared-empty');
    if (empty) {
        empty.remove();
    }

    const chip = document.createElement('span');
    chip.className = 'cleared-chip';
    chip.textContent = name;
    els.clearedList.appendChild(chip);
}

/**
 * 切换寻宝场景舞台。
 * 场景数据在下方 SCENES 中定义，每次切换都会重建道具节点，
 * 从而让 CSS 动画从头播放，形成“走进新场景”的观感。
 * @param {string} key 场景键名
 */
function setScene(key) {
    const scene = SCENES[key] || SCENES.library;

    els.journey.dataset.scene = key;
    els.sceneIcon.textContent = scene.icon;
    els.sceneCaption.textContent = scene.caption;
    els.sceneProps.innerHTML = scene.props
        .map((prop, index) => {
            const left = 6 + index * 21;
            const delay = (-index * 0.7).toFixed(2);
            const duration = (3.4 + index * 0.35).toFixed(2);
            return `<span class="prop" style="left:${left}%; animation-delay:${delay}s; animation-duration:${duration}s">${prop}</span>`;
        })
        .join('');

    // 重新触发中央图标的弹入动画
    els.sceneIcon.classList.remove('scene-icon-pop');
    void els.sceneIcon.offsetWidth;
    els.sceneIcon.classList.add('scene-icon-pop');

    // 整个舞台轻微“换景”，让场景切换更明显
    els.journey.classList.remove('is-shifting');
    void els.journey.offsetWidth;
    els.journey.classList.add('is-shifting');
}

/**
 * 更新选项上方的提示。
 * @param {string} text 提示内容
 * @param {'normal'|'danger'|'win'} tone 语气
 */
function setHint(text, tone = 'normal') {
    els.hintText.textContent = text;
    els.hint.classList.toggle('is-danger', tone === 'danger');
    els.hint.classList.toggle('is-win', tone === 'win');
}

/** 计算本局已用时间，用于结算面板 */
function formatDuration() {
    const seconds = Math.max(1, Math.round((Date.now() - game.stats.startTime) / 1000));
    if (seconds < 60) {
        return `${seconds} 秒`;
    }
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/* ================= 4. 剧本数据 =================
 * 每个关卡都包含：
 *   badge   HUD 上显示的章节名
 *   title   关卡标题
 *   short   通过后写入右上角“已通过”的地点简称
 *   scene   对应的动画场景键名
 *   intro   进入关卡时逐行输出的旁白
 *   choices 两个选项；rate 只用于后台概率判定，不会显示给玩家；
 *           successStatus 为成功后的去向（continue = 继续，skip = 直接通关）
 *   failTitle 失败结算时显示的死亡原因
 * 所有概率都严格按需求设置，判定时使用 Math.random() < rate。
 * ============================================== */
const LEVELS = {
    /* ---------- 第 1 关：迷雾森林岔路口 ---------- */
    forest: {
        badge: '第 1 关',
        title: '迷雾森林岔路口',
        short: '迷雾森林',
        scene: 'forest',
        icon: '🌲',
        intro: [
            '浓雾像潮水一样漫过脚踝，森林深处传来若有若无的低语。',
            '岔路口立着一块长满青苔的木牌：左边浮着幽蓝的光点，右边印着深陷泥中的巨大脚印。',
        ],
        choices: [
            {
                key: 'A',
                label: '跟随发光蘑菇',
                icon: '🍄',
                rate: 0.7,
                success: [
                    '你蹲下身，跟着那一串幽蓝的蘑菇灯一路向前。',
                    '雾气忽然散开，一位只有巴掌大的森林精灵扇着翅膀出现，为你指了指神庙的方向。',
                    '【顺利通过】精灵的指引让你少走了许多弯路。',
                ],
                fail: [
                    '你伸手触碰蘑菇的瞬间，菌盖喷出一团紫色孢子。',
                    '致幻毒气钻进鼻腔，森林在眼前扭曲成无数张怪脸……',
                    '【Game Over】你在幻觉中永远迷失了方向。',
                ],
                failTitle: '迷失在致幻迷雾中',
            },
            {
                key: 'B',
                label: '踏上野兽脚印',
                icon: '🐾',
                rate: 0.3,
                success: [
                    '你硬着头皮踩上脚印，灌木丛里传来沉重的呼吸声。',
                    '一头通体雪白的神兽踏雾而出，它低头嗅了嗅你，转身为你开路。',
                    '【顺利通过】神兽一直把你送到森林边界。',
                ],
                fail: [
                    '脚印的主人不是鹿，而是一头饥饿的猛兽。',
                    '它从树影里扑出，你转身狂奔，却听见身后的爪步声越来越近……',
                    '【Game Over】迷雾森林成了你的终点。',
                ],
                failTitle: '猛兽的晚餐',
            },
        ],
    },

    /* ---------- 第 2 关：渡过鳄鱼沼泽 ---------- */
    swamp: {
        badge: '第 2 关',
        title: '渡过鳄鱼沼泽',
        short: '鳄鱼沼泽',
        scene: 'swamp',
        icon: '🐊',
        intro: [
            '森林尽头是一片冒着气泡的沼泽，浑浊的水面下，几双冰冷的眼睛正缓缓游动。',
            '通往对岸只有两条路：水面上漂浮的朽木，或者你背包里那块还带着血水的鲜肉。',
        ],
        choices: [
            {
                key: 'A',
                label: '踩着水面上的浮木跳过去',
                icon: '🪵',
                rate: 0.6,
                success: [
                    '你深吸一口气，踩着浮木一跃、再一跃，鞋底几次擦过鳄鱼的背脊。',
                    '最后一跳落在泥岸上，你滚了一圈，回头看见鳄鱼们不甘地沉入水底。',
                ],
                fail: [
                    '第三块浮木在你脚下翻了个身。',
                    '冰冷的水灌进口鼻，水下的黑影同时睁开了眼睛……',
                    '【Game Over】沼泽吞没了你的呼救声。',
                ],
                failTitle: '滑落鳄鱼沼泽',
            },
            {
                key: 'B',
                label: '扔出背包里的鲜肉引开鳄鱼',
                icon: '🥩',
                rate: 0.9,
                success: [
                    '你把鲜肉抛向远处，水面瞬间炸开一片水花。',
                    '趁鳄鱼们争抢的间隙，你稳稳地踏过浮木，抵达对岸。',
                ],
                fail: [
                    '肉块刚落水，水面却裂开一道更大的涟漪。',
                    '鳄鱼王浮出水面，金色的竖瞳锁定了你——它显然更喜欢活蹦乱跳的猎物。',
                    '【Game Over】你成了鳄鱼王的加餐。',
                ],
                failTitle: '惊动了鳄鱼王',
            },
        ],
    },

    /* ---------- 地下支线：失控的矿车 ---------- */
    minecart: {
        badge: '地底矿车',
        title: '失控的地底矿车',
        short: '地底矿车',
        scene: 'minecart',
        icon: '🛤️',
        intro: [
            '黑暗尽头，一辆锈迹斑斑的矿车正沿着铁轨缓缓滑动，你跳上去的瞬间，它猛地加速。',
            '前方轨道分成两股：一根生锈的加速拉杆就在手边，而刹车踏板已经锈死了一半。',
        ],
        choices: [
            {
                key: 'A',
                label: '拉下生锈的加速拉杆！',
                icon: '⚡',
                rate: 0.5,
                successStatus: 'skip',
                success: [
                    '你咬牙拉下拉杆，矿车像离弦之箭冲进黑暗。',
                    '铁轨尽头是一扇巨大的石门，矿车撞开石门的瞬间，你看见了满室金光！',
                ],
                fail: [
                    '拉杆发出刺耳的断裂声，加速器却卡死在最大档位。',
                    '矿车冲出断裂的轨道，坠入无底的矿坑……',
                    '【Game Over】黑暗吞没了矿车的轰鸣。',
                ],
                failTitle: '矿车坠入深渊',
            },
            {
                key: 'B',
                label: '踩下刹车，弃车逃生！',
                icon: '🪂',
                rate: 0.8,
                success: [
                    '你死死踩住刹车，在矿车减速的瞬间滚出车厢。',
                    '身后传来矿车坠毁的巨响，而你抓住岩壁上的藤蔓，爬回了山道。',
                    '【继续前进】你重新踏上了通往神庙的路。',
                ],
                fail: [
                    '刹车踏板应声断裂，矿车带着你冲出轨道。',
                    '你被甩向漆黑的深渊，连回声都没有留下……',
                    '【Game Over】深渊成为了你的终点。',
                ],
                failTitle: '坠入地底深渊',
            },
        ],
    },

    /* ---------- 地下支线：失修的传送阵 ---------- */
    teleport: {
        badge: '远古法阵',
        title: '失修的远古传送阵',
        short: '远古传送阵',
        scene: 'teleport',
        icon: '🔮',
        intro: [
            '你落在潮湿的石室中央，脚下是一座刻满符文的巨大法阵，符文正像活物一样游走。',
            '法阵边缘刻着一行小字：“以力启阵，或以智寻路。”',
        ],
        choices: [
            {
                key: 'A',
                label: '注入全部体力，强行启动法阵！',
                icon: '💥',
                rate: 0.5,
                successStatus: 'skip',
                success: [
                    '你把手掌按在阵心，将全部力气灌入符文。',
                    '白光吞没视野，下一瞬，你已站在宝箱房间的正中央！',
                ],
                fail: [
                    '符文亮到极致，石室开始剧烈震颤。',
                    '法阵超载，白光变成刺眼的白炽，你在爆炸中失去了意识……',
                    '【Game Over】远古法阵拒绝了你。',
                ],
                failTitle: '法阵超载爆炸',
            },
            {
                key: 'B',
                label: '仔细观察符文，寻找常规出口！',
                icon: '🧭',
                rate: 0.8,
                success: [
                    '你压住心慌，顺着符文边缘摸索，发现一块颜色略深的石板。',
                    '石板后是一条向上升的旋转楼梯，你沿着它爬回了地面。',
                    '【继续前进】你重新踏上了通往神庙的路。',
                ],
                fail: [
                    '你看错了符文的走向，脚下的石板突然消失。',
                    '时空裂缝在你身后合拢，你被困在了没有方向的黑暗里……',
                    '【Game Over】你再也找不到回来的路。',
                ],
                failTitle: '被困时空裂缝',
            },
        ],
    },

    /* ---------- 第 3 关：攀爬悬崖吊桥 ---------- */
    cliff: {
        badge: '第 3 关',
        title: '攀爬悬崖吊桥',
        short: '悬崖吊桥',
        scene: 'cliff',
        icon: '🌉',
        intro: [
            '山壁之间横着一座摇摇欲坠的吊桥，木板被山风吹得吱呀作响。',
            '桥边垂下一根粗壮的古老藤蔓，表面覆着潮湿的青苔。',
        ],
        choices: [
            {
                key: 'A',
                label: '快速跑过摇晃的木桥',
                icon: '🏃',
                rate: 0.7,
                success: [
                    '你把心一横，踩着木板一路狂奔。',
                    '最后一块木板在身后断裂，而你稳稳落在对面的岩台上。',
                ],
                fail: [
                    '跑至桥心时，一块朽木突然塌陷。',
                    '你抓住铁索，却听见另一侧的锁扣崩开的声音……',
                    '【Game Over】你随着断桥坠入山谷。',
                ],
                failTitle: '吊桥断裂',
            },
            {
                key: 'B',
                label: '顺着桥边的古老粗藤蔓爬过去',
                icon: '🌿',
                rate: 0.5,
                success: [
                    '你抓住藤蔓，一点一点贴着岩壁横移。',
                    '手掌磨出了血，但你还是爬到了对岸。',
                ],
                fail: [
                    '藤蔓上盘着一条伪装成树皮的毒蛇。',
                    '它在你手背留下两颗牙印，麻痹感迅速蔓延……',
                    '【Game Over】你从藤蔓上松开了手。',
                ],
                failTitle: '惊动了毒蛇',
            },
        ],
    },

    /* ---------- 第 4 关：破解神庙迷宫 ---------- */
    maze: {
        badge: '第 4 关',
        title: '破解神庙迷宫',
        short: '神庙迷宫',
        scene: 'maze',
        icon: '🌀',
        intro: [
            '神庙内部是一座巨大的石制迷宫，墙壁上的太阳图腾忽明忽暗。',
            '一条路通向图腾指引的深处，另一条则需要你彻底闭上眼睛。',
        ],
        choices: [
            {
                key: 'A',
                label: '遵循墙壁上的太阳图腾前进',
                icon: '☀️',
                rate: 0.8,
                success: [
                    '你跟着太阳图腾的明暗变化左转、右转。',
                    '最后一扇石门在你面前打开，守卫大厅就在眼前。',
                ],
                fail: [
                    '图腾在你走到第七个路口时突然全部熄灭。',
                    '脚下的石板翻转，你掉进布满尖刺的陷坑——',
                    '【Game Over】太阳图腾本身就是陷阱。',
                ],
                failTitle: '落入图腾陷阱',
            },
            {
                key: 'B',
                label: '闭上眼睛，摸着右侧墙壁一直走',
                icon: '🙈',
                rate: 0.6,
                success: [
                    '你闭上眼，右手贴着冰凉的石壁，一步一步向前。',
                    '不知走了多久，墙壁尽头出现一道光缝，你推开石门。',
                ],
                fail: [
                    '你摸到的不是墙，而是一只冰冷的手。',
                    '睁开眼时，一张没有五官的幽灵面孔正贴在你面前……',
                    '【Game Over】幽灵的低语成了你最后听见的声音。',
                ],
                failTitle: '迷宫深处的幽灵',
            },
        ],
    },

    /* ---------- 第 5 关：直面神庙守卫 ---------- */
    guardian: {
        badge: '第 5 关',
        title: '直面神庙守卫',
        short: '神庙守卫',
        scene: 'guardian',
        icon: '🗿',
        intro: [
            '守卫大厅中央，一尊三米高的石像缓缓转过头，眼中的火焰骤然亮起。',
            '它挡在宝箱房间唯一的入口前，沉重的石拳砸裂了地面。',
        ],
        choices: [
            {
                key: 'A',
                label: '拔出武器，正面硬刚！',
                icon: '⚔️',
                rate: 0.3,
                success: [
                    '你握紧武器冲了上去，在石拳落下的空隙里跃上它的手臂。',
                    '最后一击正中石像额心的符文，庞然大物轰然碎裂。',
                ],
                fail: [
                    '石拳比想象中快得多。',
                    '你被正面击中，整个人撞碎了三根石柱……',
                    '【Game Over】守卫甚至没有再看你一眼。',
                ],
                failTitle: '被石像守卫击飞',
            },
            {
                key: 'B',
                label: '寻找周围的神庙机关砸晕它！',
                icon: '⚙️',
                rate: 0.7,
                success: [
                    '你绕着大厅狂奔，注意到石像后方的铁链连接着一块悬空的巨石。',
                    '你砍断锁扣，巨石落下，正中石像后脑，守卫轰然跪倒。',
                ],
                fail: [
                    '你拉动机关，齿轮却发出干涩的卡壳声。',
                    '石像转过身，燃烧的眼睛锁定了你……',
                    '【Game Over】机关没能救你第二次。',
                ],
                failTitle: '机关卡壳',
            },
        ],
    },
};

/* ---------- 场景舞台数据 ----------
 * 每个场景由“中央图标 + 地点名 + 5 个漂浮道具”组成。
 * 道具位置由 CSS 中的 --i 计算，切换场景时 JS 重建节点，
 * 让漂浮、旋转、脉冲等动画重新播放，形成视觉上的场景转换。
 */
const SCENES = {
    library: { icon: '📖', caption: '古老的图书馆', props: ['📚', '🕯️', '✦', '✧', '✦'] },
    forest: { icon: '🌲', caption: '迷雾森林', props: ['🌿', '🌲', '🍄', '✦', '🌲'] },
    swamp: { icon: '🐊', caption: '鳄鱼沼泽', props: ['🌾', '💧', '🐊', '💧', '🌾'] },
    minecart: { icon: '🛤️', caption: '地底矿车', props: ['⚙️', '✦', '⛏️', '✦', '⚙️'] },
    teleport: { icon: '🔮', caption: '远古传送阵', props: ['✦', '🔯', '✦', '✧', '✦'] },
    cliff: { icon: '🌉', caption: '悬崖吊桥', props: ['🌿', '💨', '⛰️', '✦', '🌿'] },
    maze: { icon: '🌀', caption: '神庙迷宫', props: ['☀️', '✦', '☀️', '✦', '✦'] },
    guardian: { icon: '🗿', caption: '神庙守卫', props: ['🔥', '🗿', '👁️', '🗿', '🔥'] },
    treasure: { icon: '💎', caption: '神庙宝库', props: ['✨', '💰', '💎', '🏆', '✨'] },
};

/* ================= 5. 剧情输出（打字机 + 逐行淡入） ================= */

/**
 * 逐字输出一行剧情，并自动滚到底部。
 *
 * 这里同样是一个 async 函数：每输出几个字就 `await delay(...)` 一次，
 * 于是浏览器有机会重绘 UI，玩家看到文字像打字机一样出现，
 * 同时 caret 光标保持闪烁。
 *
 * @param {string} text 要输出的文字
 * @param {object} options
 * @param {number} options.runId 当前局编号，用于中断旧流程
 * @param {string} [options.tone] 语气：normal / heading / success / danger / secret / choice / system
 * @param {number} [options.speed] 每个字的间隔毫秒数
 * @param {number} [options.waitAfter] 本行结束后的停顿毫秒数
 * @returns {Promise<HTMLElement>} 生成的剧情行元素
 */
async function typeLine(text, options = {}) {
    const {
        runId,
        tone = 'normal',
        speed = TYPE_SPEED,
        waitAfter = LINE_PAUSE,
    } = options;

    ensureActive(runId);

    // 第一句真正剧情出现时，移除“羊皮卷正在展开”的占位文字
    const placeholder = els.storyLog.querySelector('.story-placeholder');
    if (placeholder) {
        placeholder.remove();
    }

    const line = document.createElement('p');
    line.className = `story-line tone-${tone}`;

    const content = document.createElement('span');
    content.className = 'line-text';

    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.setAttribute('aria-hidden', 'true');

    line.appendChild(content);
    line.appendChild(caret);
    els.storyLog.appendChild(line);
    scrollStoryToBottom();

    if (speed <= 0) {
        // 系统开启了“减少动态效果”，直接一次性显示
        content.textContent = text;
    } else {
        // 用 Array.from 而不是 split，避免把 emoji 拆成半个字符
        const characters = Array.from(text);
        for (let i = 0; i < characters.length; i += 1) {
            // 每次 await 之后都检查是否已经被“重新开始”取消
            ensureActive(runId);
            content.textContent += characters[i];
            if (i % 4 === 0) {
                scrollStoryToBottom();
            }
            await delay(speed);
        }
    }

    // 打字完成，去掉闪烁光标
    caret.remove();
    scrollStoryToBottom();

    if (waitAfter > 0) {
        await delay(waitAfter);
        ensureActive(runId);
    }
    return line;
}

/* ================= 6. 选项渲染与点击桥接 ================= */

/** 清空选项区，并把交互锁上（剧情播放期间不允许选择） */
function clearChoices() {
    els.choices.innerHTML = '';
    game.locked = true;
}

/**
 * 把当前关卡的两个选项渲染成按钮。
 * 每个按钮都绑定 click 监听：点击时进入 selectChoice()。
 * @param {Array<object>} choices 选项数据
 * @param {number} runId 当前局编号
 */
function renderChoices(choices, runId) {
    els.choices.innerHTML = '';
    game.locked = false;

    const fragment = document.createDocumentFragment();

    choices.forEach((choice, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'choice-btn';
        button.dataset.key = choice.key.toLowerCase();
        button.style.animationDelay = `${index * 110}ms`;
        button.setAttribute('aria-label', `${choice.key}：${choice.label}`);

        const key = document.createElement('span');
        key.className = 'choice-key';
        key.textContent = choice.key;

        const label = document.createElement('span');
        label.className = 'choice-label';
        label.textContent = `${choice.icon ? `${choice.icon} ` : ''}${choice.label}`;

        // 只展示行动描述，不向玩家透露任何成功概率
        button.append(key, label);

        /* ------------------------------------------------------------
         * 关键的一行：点击事件只负责调用 selectChoice()，
         * 并不在这里写后续剧情。真正的流程控制仍在 async 主函数里，
         * selectChoice() 会 resolve 那个挂起的 Promise，
         * 让 `await waitForUserChoice()` 后面的代码继续执行。
         * ------------------------------------------------------------ */
        button.addEventListener('click', () => selectChoice(choice, runId));

        fragment.appendChild(button);
    });

    els.choices.appendChild(fragment);
}

/**
 * 玩家点击选项后的处理：
 * 1) 防止重复点击（game.locked）；
 * 2) 给选中的按钮加金色高亮，其余按钮禁用；
 * 3) 调用 game.choiceResolve(choice)，唤醒等待中的 async 函数。
 * @param {object} choice 被选中的选项
 * @param {number} runId 当前局编号
 */
function selectChoice(choice, runId) {
    if (game.locked || runId !== game.runId) {
        return;
    }
    game.locked = true;

    const buttons = els.choices.querySelectorAll('.choice-btn');
    buttons.forEach((button) => {
        button.disabled = true;
        button.classList.toggle('is-chosen', button.dataset.key === choice.key.toLowerCase());
    });

    const resolve = game.choiceResolve;
    game.choiceResolve = null;
    game.choiceReject = null;

    setHint('命运正在揭晓……');
    // 这一句是“按钮点击”与“async/await”之间的桥梁
    if (resolve) {
        resolve(choice);
    }
}

/**
 * 渲染选项并等待玩家选择。
 * 这是主流程里唯一会长时间停住的地方 —— 但它停得毫无阻塞。
 * @param {Array<object>} choices 选项数据
 * @param {number} runId 当前局编号
 * @returns {Promise<object>} 玩家点选的选项
 */
async function offerChoices(choices, runId) {
    clearChoices();
    setHint('请做出你的选择 —— 命运正在等待');
    await delay(320);
    ensureActive(runId);

    // 先把 Promise 准备好，再渲染按钮，避免极端情况下点击早于 resolver 注册
    const pendingChoice = waitForUserChoice();
    renderChoices(choices, runId);

    // ↓↓↓ 主异步函数在此暂停，直到按钮 click 调用 resolve ↓↓↓
    const choice = await pendingChoice;

    // 被“重新开始”打断时，这里会抛出 RunCancelled，终止整条旧流程
    ensureActive(runId);
    return choice;
}

/* ================= 7. 关卡执行 ================= */

/**
 * 播放一个完整关卡：旁白 → 等待选择 → 概率判定 → 结果旁白。
 *
 * 整个函数是一场“从上到下”的叙事：
 *   await typeLine(...)  → 等文字打完
 *   await offerChoices() → 等玩家点击
 *   Math.random()        → 判定成功 / 失败
 * 没有一层嵌套回调，读代码就像读剧本。
 *
 * @param {object} level 关卡数据
 * @param {number} runId 当前局编号
 * @returns {Promise<'continue'|'skip'|'fail'>} 成功后的去向
 */
async function runLevel(level, runId) {
    ensureActive(runId);

    setChapter(level.badge);
    setScene(level.scene);
    clearChoices();
    setHint('剧情推进中……');

    await delay(320);
    ensureActive(runId);

    // 关卡标题（打字机速度稍慢，强调章节感）
    await typeLine(`${level.icon} ${level.title}`, {
        runId,
        tone: 'heading',
        speed: REDUCED_MOTION ? 0 : 30,
        waitAfter: 260,
    });

    // 逐行输出关卡旁白
    for (const sentence of level.intro) {
        await typeLine(sentence, { runId });
    }

    await delay(300);
    ensureActive(runId);

    // 这里会一直 await 到玩家点击按钮
    const choice = await offerChoices(level.choices, runId);

    await typeLine(`你选择了 ${choice.key}：${choice.label}`, {
        runId,
        tone: 'choice',
        speed: REDUCED_MOTION ? 0 : 24,
    });

    setHint('命运的骰子正在滚动……');
    await delay(560);
    ensureActive(runId);

    // 严格按选项配置的概率判定：rate 只在后台使用，不展示给玩家
    const success = Math.random() < choice.rate;
    const resultLines = success ? choice.success : choice.fail;
    const resultTone = success ? 'success' : 'danger';

    for (const sentence of resultLines) {
        await typeLine(sentence, { runId, tone: resultTone, waitAfter: 230 });
    }

    await delay(360);

    // 失败：展示 Game Over 结算，并告诉主流程“到此为止”
    if (!success) {
        await showGameOver(level, choice, runId);
        return 'fail';
    }

    game.stats.cleared += 1;
    markLevelCleared(level.short);
    await typeLine('— 关卡通过 —', {
        runId,
        tone: 'system',
        speed: REDUCED_MOTION ? 0 : 24,
        waitAfter: 280,
    });

    // successStatus 默认 continue；地下支线的 A 选项配置为 skip（直接通关）
    return choice.successStatus || 'continue';
}

/* ================= 8. 序章与地下支线探索 ================= */

/** 序章：固定剧情，不涉及任何随机数 */
async function playPrologue(runId) {
    setChapter('序章');
    setScene('library');

    await delay(420);
    await typeLine('序章 · 古老的图书馆', {
        runId,
        tone: 'heading',
        speed: REDUCED_MOTION ? 0 : 30,
        waitAfter: 240,
    });

    await typeLine('在古老的图书馆里找到了第一个线索...', { runId });
    await typeLine('泛黄的羊皮纸边缘已经发脆，上面爬满了看不懂的古代文字。', { runId });
    await typeLine('你摊开对照表，逐字比对。烛火摇晃了三次——', { runId });
    await typeLine('解码成功!出发寻找神庙...', {
        runId,
        tone: 'success',
        speed: REDUCED_MOTION ? 0 : 24,
    });
    await typeLine('你收起地图，推开了图书馆沉重的木门。', { runId, tone: 'system' });

    await delay(420);
}

/**
 * 通过第 2 关后的岔路探索。
 * 后台规则：80% 继续普通路线；20% 坠入地下支线，
 * 再以 50/50 决定进入矿车关或传送阵关。
 * 整个判定过程不会向玩家展示任何“触发/未触发”的系统提示。
 * @param {number} runId 当前局编号
 * @returns {Promise<object|null>} 地下支线关卡对象或 null
 */
async function maybeEnterSidePath(runId) {
    await typeLine('你爬上岸，泥水顺着衣角滴落。前方的山壁间隐约传来风声……', {
        runId,
        tone: 'system',
    });
    await delay(420);
    ensureActive(runId);

    // 第一次判定：20% 进入地下支线
    const enterSidePath = Math.random() < 0.2;

    if (!enterSidePath) {
        await typeLine('你沿着兽道继续向神庙深处前进，风从岩壁间穿过。', {
            runId,
            tone: 'system',
        });
        await delay(320);
        return null;
    }

    // 触发支线：只输出剧情，不出现任何系统判定字样
    await typeLine('脚底的苔藓忽然塌陷，你坠入一道被藤蔓遮住的裂缝！', {
        runId,
        tone: 'secret',
    });
    await delay(480);
    ensureActive(runId);

    const goMinecart = Math.random() < 0.5;

    await typeLine(
        goMinecart
            ? '黑暗尽头，你听见了金属摩擦的刺耳声响……'
            : '黑暗尽头，你看见一圈幽蓝色的符文缓缓亮起……',
        { runId, tone: 'secret' },
    );
    await delay(360);
    ensureActive(runId);

    return goMinecart ? LEVELS.minecart : LEVELS.teleport;
}

/* ================= 9. 结算弹层与彩带 ================= */

/** 生成通关彩带（纯 CSS 动画驱动，JS 只负责随机位置和颜色） */
function spawnConfetti() {
    els.confetti.innerHTML = '';
    const colors = ['#ffd98e', '#e8c27a', '#7fe3b0', '#8fb6ff', '#c6a6ff', '#ff9b9b', '#ffffff'];
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < 46; i += 1) {
        const piece = document.createElement('span');
        piece.className = 'confetti-piece';
        piece.style.left = `${(Math.random() * 100).toFixed(2)}%`;
        piece.style.background = colors[i % colors.length];
        piece.style.setProperty('--drift', `${(Math.random() * 180 - 90).toFixed(0)}px`);
        piece.style.animationDelay = `${(Math.random() * 1.3).toFixed(2)}s`;
        piece.style.animationDuration = `${(2.4 + Math.random() * 2.4).toFixed(2)}s`;
        piece.style.width = `${(6 + Math.random() * 5).toFixed(0)}px`;
        piece.style.height = `${(10 + Math.random() * 8).toFixed(0)}px`;
        fragment.appendChild(piece);
    }

    els.confetti.appendChild(fragment);
}

/**
 * 打开结算弹层。
 * @param {object} config
 * @param {'win'|'fail'} config.type 结局类型
 * @param {string} config.icon 图标
 * @param {string} config.title 标题
 * @param {string} config.text 描述
 * @param {Array<[string, string]>} config.stats 统计项
 * @param {string} config.buttonText 按钮文字
 */
function openOverlay({ type, icon, title, text, stats, buttonText }) {
    els.overlay.hidden = false;
    els.overlayCard.className = `overlay-card is-${type}`;
    els.overlayIcon.textContent = icon;
    els.overlayTitle.textContent = title;
    els.overlayText.textContent = text;
    els.overlayBtn.textContent = buttonText;

    els.overlayStats.innerHTML = '';
    stats.forEach(([label, value]) => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        const result = document.createElement('strong');
        name.textContent = label;
        result.textContent = value;
        item.append(name, result);
        els.overlayStats.appendChild(item);
    });

    if (type === 'win') {
        spawnConfetti();
    } else {
        els.confetti.innerHTML = '';
    }

    // 等弹层动画播完再聚焦按钮，避免焦点跳动
    window.setTimeout(() => els.overlayBtn.focus({ preventScroll: true }), 420);
}

/** 关闭结算弹层并清空彩带 */
function closeOverlay() {
    els.overlay.hidden = true;
    els.overlayCard.className = 'overlay-card';
    els.confetti.innerHTML = '';
}

/**
 * 失败结算：所有失败分支最终都会走到这里。
 * @param {object} level 失败所在关卡
 * @param {object} choice 导致失败的选项
 * @param {number} runId 当前局编号
 */
async function showGameOver(level, choice, runId) {
    game.running = false;
    setHint('旅程结束 · 你倒在了这里', 'danger');

    // 留一点时间让玩家读完最后一句失败旁白
    await delay(720);
    ensureActive(runId);

    openOverlay({
        type: 'fail',
        icon: '💀',
        title: 'Game Over',
        text: `${choice.failTitle}。你的探险止步于「${level.title}」。`,
        stats: [
            ['到达章节', level.badge],
            ['成功通过', `${game.stats.cleared} 关`],
            ['冒险用时', formatDuration()],
        ],
        buttonText: '再试一次',
    });
}

/**
 * 终章：正常通关或地下支线抽中 50% 直接通关时都会调用。
 * @param {number} runId 当前局编号
 */
async function playEnding(runId) {
    setChapter('终章');
    setScene('treasure');
    setHint('宝箱就在眼前……', 'win');
    clearChoices();

    await delay(360);
    ensureActive(runId);

    await typeLine('终章 · 神庙宝库', {
        runId,
        tone: 'heading',
        speed: REDUCED_MOTION ? 0 : 30,
        waitAfter: 260,
    });
    await typeLine('石像倒塌的尘埃落定，宝箱房间的门在你面前缓缓打开。', { runId });
    await typeLine('你拂去箱盖上的灰尘，锁扣在指尖发出轻响。', { runId });
    await typeLine('恭喜！你打开了神秘的箱子，找到了传说中的 Argus-Cell 宝藏！', {
        runId,
        tone: 'success',
        speed: REDUCED_MOTION ? 0 : 26,
        waitAfter: 300,
    });
    await typeLine('金色的光芒从箱中涌出，照亮了整座神庙……', {
        runId,
        tone: 'secret',
    });

    await delay(620);
    ensureActive(runId);

    game.running = false;
    openOverlay({
        type: 'win',
        icon: '💎',
        title: '宝藏到手！',
        text: '你带着 Argus-Cell 宝藏走出了神庙，成为传说中的寻宝者。',
        stats: [
            ['找到宝藏', 'Argus-Cell'],
            ['成功通过', `${game.stats.cleared} 关`],
            ['冒险用时', formatDuration()],
        ],
        buttonText: '再玩一次',
    });
}

/* ================= 10. 主线流程编排 ================= */

/**
 * 整局游戏的主 async 函数。
 * 每一行 await 就是一个“剧情节点”，顺序执行、绝无回调嵌套。
 * @param {number} runId 当前局编号
 */
async function playGame(runId) {
    await playPrologue(runId);

    // 第 1 关
    let outcome = await runLevel(LEVELS.forest, runId);
    if (outcome === 'fail') {
        return;
    }

    // 第 2 关
    outcome = await runLevel(LEVELS.swamp, runId);
    if (outcome === 'fail') {
        return;
    }

    // 通过第 2 关后：后台以 80% / 20% 决定是否进入地下支线
    const sidePath = await maybeEnterSidePath(runId);

    if (sidePath) {
        outcome = await runLevel(sidePath, runId);

        if (outcome === 'fail') {
            return;
        }

        // 支线选择 A 成功：跳过剩余关卡，直接进入终章
        if (outcome === 'skip') {
            await playEnding(runId);
            return;
        }

        // 支线选择 B 成功：翻回山道，继续第 3 关
        await typeLine('你顺着藤蔓翻上山道，神庙的轮廓已在山巅显现。', {
            runId,
            tone: 'system',
        });
        await delay(380);
        ensureActive(runId);
    }

    // 第 3、4、5 关顺序执行
    const restLevels = [LEVELS.cliff, LEVELS.maze, LEVELS.guardian];
    for (const level of restLevels) {
        outcome = await runLevel(level, runId);
        if (outcome === 'fail') {
            return;
        }
    }

    await playEnding(runId);
}

/* ================= 11. 开局 / 重开与事件绑定 ================= */

/** 把界面恢复到初始状态 */
function resetUI() {
    els.storyLog.innerHTML = '<p class="story-placeholder">羊皮卷正在展开……</p>';
    els.storyScroll.scrollTop = 0;
    clearChoices();
    setChapter('序章');
    resetCleared();
    setScene('library');
    setHint('正在翻开羊皮卷……');
}

/**
 * 开始（或重新开始）一局游戏。
 * 注意：这里没有 then()，只用一个 try/catch 等待整条主线结束。
 */
async function startGame() {
    // 中断上一局可能还挂着的“等待选择”Promise
    cancelPendingChoice();

    // 局编号 +1，旧的 async 流程会在下一次检查时自行退出
    const runId = game.runId + 1;
    game.runId = runId;
    game.locked = true;
    game.running = true;
    game.stats = { startTime: Date.now(), cleared: 0 };

    closeOverlay();
    resetUI();

    try {
        await playGame(runId);
    } catch (error) {
        if (error instanceof RunCancelled) {
            // 玩家点了“重新开始”，旧流程安静退出即可
            console.info('上一轮冒险已取消，新的一轮开始。');
        } else {
            console.error('游戏流程出现异常：', error);
        }
    }
}

/* ---------- 事件绑定 ---------- */

els.restartBtn.addEventListener('click', () => {
    startGame();
});

els.overlayBtn.addEventListener('click', () => {
    startGame();
});

// 键盘辅助：A / B 键等同于点击对应按钮
document.addEventListener('keydown', (event) => {
    if (game.locked) {
        return;
    }
    const key = event.key.toLowerCase();
    if (key !== 'a' && key !== 'b') {
        return;
    }
    const button = els.choices.querySelector(`.choice-btn[data-key="${key}"]`);
    if (button) {
        event.preventDefault();
        button.click();
    }
});

/* ---------- 启动 ---------- */
buildDust();
startGame();

