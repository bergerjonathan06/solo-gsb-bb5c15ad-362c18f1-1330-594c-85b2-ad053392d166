'use strict';

/**
 * 换景线路规划（逐组联合搜索，纯函数）。
 *
 * 区位为节点、通道为无向边构成通道图。仅对**全量重放整组生效**的提示逐组
 * 规划线路（失败提示不规划）：
 *
 *  - 同组每条道具转移分配一条**简单路径**（不重复经过区位的通道序列，
 *    路径用完整经过区位列表表示，含来源与目标）；
 *  - 同组任意两条路径**不得共用通道**（边不相交；经过同一区位是允许的）；
 *  - 对整组**联合搜索**可行组合：先为每条转移枚举全部简单路径（按长度
 *    升序，同等长度按通道录入顺序），再按「候选路径最少的转移先定」
 *    （MRV）做带回溯的深度优先搜索——不是逐条固定最短路：某条转移的
 *    最短路径若与组内其他转移争用通道，会回溯改走更长的路径；
 *  - 无解时区分两类原因：
 *      disconnected（端点不连通）：存在转移的来源与目标区位在通道图中
 *        根本不连通（该转移一条简单路径都没有），受影响转移 = 这些转移；
 *      contention（通道争用）：每条转移单独都有路径可走，但任何组合都
 *        必然有通道被共用，受影响转移 = 组内全部转移（附各自候选路径数）。
 *
 * 规模说明：实际舞台的区位与通道数为个位/十位数，枚举与搜索均为毫秒级；
 * 为防御异常规模输入，设有单条转移候选路径数上限（PATH_CAP）与单组联合
 * 搜索节点上限（SEARCH_CAP）。候选路径被截断时，若搜索失败则**不能断定**
 * 必然无解，该组标记为 'limited' 而非 'contention'；超限同理返回 'limited'。
 */

/** 单条转移候选简单路径枚举上限（防御异常规模输入） */
const PATH_CAP = 1000;
/** 单组联合搜索的搜索节点上限（防御异常规模输入） */
const SEARCH_CAP = 100000;

class RouteLimitError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'RouteLimitError';
    Object.assign(this, extra);
  }
}

/**
 * 枚举 src 到 dst 的全部简单路径（DFS，不重复经过节点）。
 *
 * @param {Map<string, string[]>} adj 无向邻接表（值为按通道录入顺序的相邻区位）
 * @param {string} src 来源区位
 * @param {string} dst 目标区位
 * @param {number} cap 路径数上限，达到即停止枚举
 * @returns {{paths: string[][], truncated: boolean}}
 *   paths 按 DFS 发现顺序；truncated 为 true 表示因达到上限而未枚举完整
 */
function enumerateSimplePaths(adj, src, dst, cap) {
  const paths = [];
  let truncated = false;
  const stack = [src];
  const onPath = new Set([src]);

  function visit(node) {
    if (paths.length >= cap) {
      truncated = true;
      return;
    }
    if (node === dst) {
      paths.push(stack.slice());
      return;
    }
    for (const next of adj.get(node) || []) {
      if (onPath.has(next)) continue;
      onPath.add(next);
      stack.push(next);
      visit(next);
      stack.pop();
      onPath.delete(next);
      if (truncated) return;
    }
  }
  visit(src);
  return { paths, truncated };
}

/** 路径占用的无向通道集合（规范键：两端区位按字典序排列） */
function pathEdgeKeys(path) {
  const keys = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    keys.push(a < b ? `${a}${b}` : `${b}${a}`);
  }
  return keys;
}

/**
 * 规划单条生效提示的线路组合。
 *
 * @param {{number:number, transfers:Array<{prop:string, from:string, to:string}>}} cue
 * @param {Map<string, string[]>} adj 通道图邻接表
 * @returns {Object} 三种形态：
 *   { status:'ok', routes:[{prop, from, to, path:[区位…]}] } —— 找到边不相交组合；
 *   { status:'infeasible', reason:'disconnected'|'contention',
 *     disconnected:[{prop,from,to}], affected:[{prop,from,to,pathCount?}] }；
 *   { status:'limited', limited:{message, code, cap} } —— 超防御上限，无法定论。
 */
function planCueRoutes(cue, adj) {
  const transfers = cue.transfers;

  // 1) 逐条枚举候选简单路径；按长度升序（短的优先试，同等长度保持枚举顺序，
  //    结果确定），联合搜索仍覆盖全部组合，不是逐条固定最短路
  const enums = transfers.map((t) => {
    const e = enumerateSimplePaths(adj, t.from, t.to, PATH_CAP);
    e.paths.sort((x, y) => x.length - y.length);
    return e;
  });

  // 端点不连通：任一条转移在通道图中没有任何路径
  const disconnected = [];
  enums.forEach((e, i) => {
    if (e.paths.length === 0) {
      const t = transfers[i];
      disconnected.push({ prop: t.prop, from: t.from, to: t.to });
    }
  });
  if (disconnected.length) {
    return {
      status: 'infeasible',
      reason: 'disconnected',
      disconnected,
      affected: disconnected,
    };
  }

  // 2) 联合搜索可行组合：候选路径最少的转移先定（MRV），冲突即回溯
  const order = transfers
    .map((_, i) => i)
    .sort((a, b) => enums[a].paths.length - enums[b].paths.length);
  const usedEdges = new Set(); // 已占用通道的规范键
  const chosen = new Array(transfers.length).fill(null);
  let nodes = 0;

  function dfs(k) {
    if (k === order.length) return true;
    if (++nodes > SEARCH_CAP) {
      throw new RouteLimitError(
        `提示 ${cue.number} 的线路联合搜索超过节点上限（${SEARCH_CAP}），未能完成规划`,
        { code: 'SEARCH_CAP', cap: SEARCH_CAP }
      );
    }
    const ti = order[k];
    for (const path of enums[ti].paths) {
      const keys = pathEdgeKeys(path);
      // 简单路径内部不重复经过区位，自然不会自占通道；只需与已选路径判交
      let clash = false;
      for (const key of keys) {
        if (usedEdges.has(key)) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      for (const key of keys) usedEdges.add(key);
      chosen[ti] = path;
      if (dfs(k + 1)) return true;
      chosen[ti] = null;
      for (const key of keys) usedEdges.delete(key);
    }
    return false;
  }

  let solved;
  try {
    solved = dfs(0);
  } catch (err) {
    if (err instanceof RouteLimitError) {
      return { status: 'limited', limited: { message: err.message, code: err.code, cap: err.cap } };
    }
    throw err;
  }

  if (solved) {
    return {
      status: 'ok',
      routes: transfers.map((t, i) => ({
        prop: t.prop,
        from: t.from,
        to: t.to,
        path: chosen[i],
      })),
    };
  }

  // 搜索失败：若有候选路径被截断，未枚举的组合中可能仍有解，不能断定争用
  if (enums.some((e) => e.truncated)) {
    return {
      status: 'limited',
      limited: {
        message: `提示 ${cue.number} 存在超过 ${PATH_CAP} 条候选简单路径，枚举被截断，无法确认是否存在可行组合`,
        code: 'PATH_CAP',
        cap: PATH_CAP,
      },
    };
  }

  // 全部候选组合都尝试过仍无解：通道争用（每条转移单独可行，整组不可行）
  return {
    status: 'infeasible',
    reason: 'contention',
    disconnected: [],
    affected: transfers.map((t, i) => ({
      prop: t.prop,
      from: t.from,
      to: t.to,
      pathCount: enums[i].paths.length,
    })),
  };
}

/**
 * 换景线路规划主入口（纯函数，随全量状态实时重算，不落地存储）。
 *
 * @param {Array<{number:number, note:string, transfers:Array}>} cues 已按提示号升序
 * @param {Array<{number:number, ok:boolean}>} results 全量重放结果（replay().results）
 * @param {Array<{name:string}>} locations 区位定义
 * @param {Array<{id:number, a:string, b:string}>} passages 无向通道（按录入顺序）
 * @returns {Object}
 *   status：'ok' 全部生效提示线路可行 / 'infeasible' 存在无解组 /
 *     'limited' 存在超限组 / 'empty' 无生效提示；
 *   planned：逐条生效提示的规划结果（形态见 planCueRoutes，另带
 *     number / note / transferCount）；
 *   effectiveCueNumbers / skippedCueCount / summary。
 */
function planRoutes(cues, results, locations, passages) {
  const resultByNumber = new Map(results.map((r) => [r.number, r]));

  // 仅纳入全量重放整组生效的提示；失败提示不规划线路
  const effective = cues.filter((c) => {
    const r = resultByNumber.get(c.number);
    return !!(r && r.ok);
  });

  // 无向通道图：区位为节点，通道为边（邻接顺序 = 通道录入顺序，保证结果确定）
  const adj = new Map(locations.map((l) => [l.name, []]));
  for (const p of passages) {
    if (!adj.has(p.a) || !adj.has(p.b)) continue; // 防御：通道端点应始终存在
    adj.get(p.a).push(p.b);
    adj.get(p.b).push(p.a);
  }

  const planned = effective.map((cue) => ({
    number: cue.number,
    note: cue.note,
    transferCount: cue.transfers.length,
    ...planCueRoutes(cue, adj),
  }));

  const okCues = planned.filter((p) => p.status === 'ok').length;
  const infeasibleCues = planned.filter((p) => p.status === 'infeasible').length;
  const limitedCues = planned.filter((p) => p.status === 'limited').length;

  return {
    status:
      effective.length === 0
        ? 'empty'
        : infeasibleCues > 0
          ? 'infeasible'
          : limitedCues > 0
            ? 'limited'
            : 'ok',
    effectiveCueNumbers: effective.map((c) => c.number),
    skippedCueCount: cues.length - effective.length,
    planned,
    summary: {
      effectiveCues: effective.length,
      skippedCues: cues.length - effective.length,
      okCues,
      infeasibleCues,
      limitedCues,
      passages: passages.length,
    },
  };
}

module.exports = {
  planRoutes,
  planCueRoutes,
  enumerateSimplePaths,
  pathEdgeKeys,
  RouteLimitError,
  PATH_CAP,
  SEARCH_CAP,
};
