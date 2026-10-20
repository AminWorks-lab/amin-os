// Grouped apps: one home entry holds several apps whose pages overlap for the user.
// Each member keeps its own service, data, view, context line and floor button; the
// suite only shows the members' views under one row of tabs. Pure data, loaded at startup.
export const SUITES=Object.freeze([
    {id:'archive',name:'存档与历史',sub:'跨应用存档、剧情存储与楼层记录',members:[['saves','跨应用存档'],['story','剧情存储'],['floors','楼层记录']]},
    {id:'library',name:'资料库',sub:'信息面板、势力概览与世界书管理',members:[['information','信息面板'],['organizations','势力概览'],['worldbooks','世界书管理']]},
    {id:'abilities',name:'能力与检定',sub:'当前生效的能力与掷骰检定',members:[['effects','能力面板'],['dice','骰子']]},
    {id:'preferences',name:'设置',sub:'外观设置与 AI 接口',members:[['settings','外观设置'],['ai','AI 设置']]},
].map(suite=>Object.freeze({...suite,members:Object.freeze(suite.members.map(([id,name])=>Object.freeze({id,name})))})));
export const SUITE_IDS=Object.freeze(SUITES.map(suite=>suite.id));
const bySuite=new Map(SUITES.map(suite=>[suite.id,suite]));
const byMember=new Map(SUITES.flatMap(suite=>suite.members.map(member=>[member.id,suite])));
export const isSuite=id=>bySuite.has(id);
export const getSuite=id=>bySuite.get(id)??null;
/** The suite an app belongs to, or null for apps that stand alone and for suites themselves. */
export const suiteOf=id=>byMember.get(id)??null;
/** Where an app id opens: a member opens its suite on its own tab; anything else opens itself (tab null). */
export function routeApp(id){
    const suite=suiteOf(id);
    return suite?{window:suite.id,tab:id}:{window:id,tab:null};
}
