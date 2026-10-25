/**
 * Example gadget templates in the spirit of Doraemon's secret gadgets. A
 * template only prefills the "登记新物品" form; effects stay prose for the
 * story model to play out, never hard-coded rules.
 */
export const GADGET_TEMPLATES = Object.freeze([
    { name: '任意门', quantity: 1, use: { mode: 'reusable', effect: '打开门并说出目的地，门后即连通该地点；只能去使用者知道或能明确描述的地方，门关上后连接消失。' } },
    { name: '竹蜻蜓', quantity: 2, use: { mode: 'reusable', effect: '戴在头顶即可飞行，速度约与自行车相当；连续飞行太久会没电，需要休息充电。' } },
    { name: '记忆面包', quantity: 5, use: { mode: 'consume', effect: '把面包按在书页或文字上印下内容，吃下后能牢牢记住这些内容；排泄后记忆随之消失。' } },
    { name: '翻译魔芋', quantity: 3, use: { mode: 'consume', effect: '吃下后数小时内能听懂并说出任何语言，包括动物的叫声，效果过后恢复原状。' } },
    { name: '缩小灯', quantity: 1, use: { mode: 'reusable', effect: '光线照到的人或物会缩小；与放大灯配合可恢复原状。' } },
    { name: '空气炮', quantity: 1, use: { mode: 'reusable', effect: '套在手上喊“砰”即射出空气弹，能击退对手或打碎轻物，不致命。' } },
    { name: '如果电话亭', quantity: 1, use: { mode: 'charges', charges: 3, effect: '进入电话亭说出“如果……的话”，世界即变成假设中的样子；再用一次说“恢复原状”可以复原。' } },
    { name: '石头帽', quantity: 1, use: { mode: 'reusable', effect: '戴上后周围的人会像对待路边石头一样完全忽视使用者，直到摘下帽子。' } },
    { name: '穿透环', quantity: 1, use: { mode: 'reusable', effect: '贴在墙壁或地面上会形成可穿过的洞，取下后墙壁恢复原状。' } },
    { name: '暂停手表', quantity: 1, use: { mode: 'charges', charges: 5, effect: '按下按钮后除使用者外时间全部停止，再按一次恢复；暂停期间无法移动被固定的大型物体。' } },
]);
