# 技术架构与协议契约 — Space War

本文档定义 `space-war` 原型的工程目录、前后端分离与权威迷雾架构、核心 TypeScript 数据契约、物理/传感算法约定，以及支持 **2 人并行零阻塞开发** 的接口边界。

---

## 1. 技术栈与 Monorepo 目录规范

### 1.1 技术选型
- **包管理与语言**：`pnpm` Workspace + TypeScript 5.x（`strict: true`）。
- **后端（`packages/server`）**：Node.js 20+ + `ws`（WebSocket 权威状态同步，10Hz 固定 Tick 循环）+ Vitest。
- **前端（`packages/client`）**：Vite + TypeScript + **分层 HTML5 Canvas2D（矢量态势层 + 像素精灵/粒子层）+ 轻量 CSS/SVG/Canvas CRT 滤镜**。
  - **选型理由**：Canvas2D 原生支持用双精度 JS `number`（float64）做完相机相对坐标偏移后再下发绘制指令，彻底消除大尺度轨道（AU 级）在 WebGL float32 顶点缓冲中的坐标抖动；同时绘制虚线椭圆、误差椭圆扇区与整数倍率放大的像素精灵/粒子极顺手，最适合 2 人原型期高速迭代。核心渲染接口保持 `IRenderer` 抽象以便后期如有需要平滑接入 Pixi/WebGL 后处理。

### 1.2 目录结构

```text
space-war/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── shared/
│   │   ├── src/
│   │   │   ├── types/          # 核心实体、命令、快照、阵营契约
│   │   │   ├── config/         # 天体表、时间压缩常数、舰船/弹药/奇观数值平衡表
│   │   │   ├── physics/        # 二体开普勒演化、状态向量<->根数、遮挡/本影几何
│   │   │   ├── transfer/       # 霍曼/兰伯特迭代求解器、隐蔽窗口搜索、Bingo Δv 计算
│   │   │   └── index.ts
│   │   └── tests/              # 轨道与转移求解纯函数单测
│   ├── server/
│   │   ├── src/
│   │   │   ├── engine/         # 10Hz SimulationLoop、Headless Runner
│   │   │   ├── systems/        # 推进、热力、多通道传感与迷雾、电子战、BVR战斗、物流、奇观
│   │   │   ├── ai/             # 简单规则测试 AI
│   │   │   ├── net/            # RoomManager、WebSocket 广播与命令校验
│   │   │   └── index.ts
│   │   └── tests/              # 全系统无头确定性单测与对局回归脚本
│   └── client/
│       ├── src/
│       │   ├── net/            # WorldProvider 接口：WsWorldProvider & MockWorldProvider
│       │   ├── camera/         # 双精度相机平移/缩放与语义缩放阈值
│       │   ├── render/         # 天体/本影、矢量轨道/航迹、像素精灵与粒子VFX、CRT叠层
│       │   ├── interaction/    # 轨道拖拽、目标交会选择、3方案预览、火控与航线交互
│       │   └── ui/             # HUD、单位控制面板、母港建造、物流与奇观进度条
│       └── index.html
└── docs/
    ├── GDD.md
    ├── ARCHITECTURE.md
    └── ISSUES.md
```

---

## 2. 核心数据契约（`packages/shared`）

> **权威迷雾红线**：服务器端严禁向客户端发送任何未探测到的敌方真实 `UnitEntity` 或 `MunitionEntity`。每个 Tick 结束时，服务器按阵营运行传感器过滤层，只构造并下发该阵营专属的 `FactionSnapshot`（己方完整实体 + 敌方裁剪后的 `SensorTrack[]` + 可见 VFX 事件）。

以下为核心接口契约（M0 `SW-02` 冻结）：

```typescript
export type FactionId = 'earth' | 'mars';
export type PropulsionType = 'chemical' | 'nuclear' | 'electric';
export type TransferMode = 'fuel' | 'fast' | 'stealth';
export type TrackConfidence = 'bearing' | 'uncertain' | 'confirmed' | 'ghost';
export type ResourceType = 'ore' | 'propellant';
export type SubsystemHealth = 'normal' | 'damaged' | 'offline';

export interface Vec2 {
  x: number; // AU（浮点 float64）
  y: number;
}

export interface KeplerOrbit {
  a: number;          // 半长轴 (AU)
  e: number;          // 偏心率 [0, 1)
  omega: number;      // 近日点幅角 (rad)
  meanAnomaly0: number; // 参考时刻 epochSec 处的平近点角 (rad)
  epochSec: number;   // 参考游戏秒
}

export interface CelestialBody {
  id: string;
  name: string;
  orbit: KeplerOrbit | null; // 太阳为 null
  visualRadiusAu: number;    // 夸大后显示半径
  occlusionRadiusAu: number; // 视线遮挡与碰撞半径
  umbraLengthAu: number;     // 太阳本影有效长度
  yields: Partial<Record<ResourceType, number>>; // 天体可开采产量基数
  ownerSlot?: FactionId;     // 地球/火星母港初始绑定
}

export interface TransferBurn {
  executeAtSec: number;
  deltaV: Vec2;              // AU/s 或标准化 km/s（统一物理单位）
  durationSec: number;       // 化学/核推短脉冲，电推连续慢燃时长
  isOccludedStart: boolean;  // 核推隐蔽方案是否落在遮挡区内
}

export interface TransferOption {
  mode: TransferMode;
  feasible: boolean;
  reason?: string;
  burns: TransferBurn[];
  previewOrbitSegments: KeplerOrbit[];
  arrivalSec: number;
  totalDeltaV: number;
  estimatedPeakIr: number;   // 0..1 归一化红外曝光风险
  bingoDeltaV: number;       // 抵达后返回最近友方补给站的最小保守 Δv
  bingoWarning: 'safe' | 'amber' | 'red';
}

export interface UnitEntity {
  id: string;
  faction: FactionId;
  kind:
    | 'home_base'
    | 'mining_outpost'
    | 'relay_depot'
    | 'freighter'
    | 'recon_corvette'
    | 'escort_frigate'
    | 'raider'
    | 'cruiser'
    | 'tanker'
    | 'drone_recon'
    | 'drone_ew';
  propulsion: PropulsionType;
  pos: Vec2;
  vel: Vec2;
  orbit: KeplerOrbit;
  hp: number;
  maxHp: number;
  subsystems: {
    propulsion: SubsystemHealth;
    sensors: SubsystemHealth;
    weapons: SubsystemHealth;
    thermal: SubsystemHealth;
  };
  deltaV: number;
  maxDeltaV: number;
  heat: number;              // 当前热沉蓄热量
  maxHeat: number;           // 热沉上限
  radiatorsOpen: boolean;    // 散热片展开=排热快但高红外
  emconSilent: boolean;      // 静默模式（收起散热片+关主动雷达）
  radarActive: boolean;
  jammerActive: boolean;
  ladarTargetAngle?: number; // 发散激光主动扫描方向 (rad)
  cargo?: Partial<Record<ResourceType, number>>;
  ammoStock: number;
  plannedBurns: TransferBurn[];
}

export interface MunitionEntity {
  id: string;
  faction: FactionId;
  profileId: 'light_interceptor' | 'heavy_torpedo'; // 共享同一底层物理实体
  pos: Vec2;
  vel: Vec2;
  orbit: KeplerOrbit;
  deltaV: number;
  targetId: string;          // 可指向舰船、空间站或敌方在飞 MunitionEntity
  seekerMode: 'ir' | 'radar' | 'inertial_then_active';
  coldCoast: boolean;        // 是否处于冷漂滑行阶段
  intercepted?: boolean;
}

export interface SensorTrack {
  trackId: string;           // 阵营侧匿名航迹 ID，不泄露真实 entityId 给不可信场景
  confidence: TrackConfidence;
  suspectedKind: 'unknown' | 'ship' | 'freighter' | 'munition' | 'station';
  bearingRad?: number;       // confidence === 'bearing' 时必填
  originPos?: Vec2;          // 方位线起点
  pos?: Vec2;                // uncertain / confirmed / ghost 估计中心
  vel?: Vec2;
  errorRadiusMajorAu?: number;
  errorRadiusMinorAu?: number;
  errorAngleRad?: number;
  estimatedOrbit?: KeplerOrbit; // confirmed / ghost 推演轨道
  lastObservedSec: number;
  isJammed: boolean;         // 当前是否受敌方压制导致误差放大
}

export interface LogisticsRoute {
  id: string;
  faction: FactionId;
  sourceBodyId: string;
  targetId: string;          // 母港或太空工业中继站
  resource: ResourceType;
  paused: boolean;
  batchSize: number;         // 1 = 单船散跑；2~3 = 编队攒批发车
  transferMode: TransferMode;
  detourWaypoint?: Vec2;     // 可选深空绕路航点
  escortUnitIds: string[];   // 绑定自动跟车护航的单位
}

export interface WonderSlot {
  index: number;             // 0..15，均布于母港共轨圆环
  status: 'empty' | 'building' | 'complete' | 'damaged_halted';
  progressOre: number;
  requiredOre: number;
  hp: number;
  maxHp: number;
}

export type PlayerCommand =
  | { type: 'plan_orbit_insertion'; unitId: string; targetOrbit: KeplerOrbit; mode: TransferMode }
  | { type: 'plan_intercept'; unitId: string; targetRefId: string; mode: TransferMode }
  | { type: 'set_emcon'; unitId: string; silent: boolean; radiatorsOpen: boolean; radarActive: boolean; jammerActive: boolean }
  | { type: 'set_ladar'; unitId: string; angleRad: number | null }
  | { type: 'launch_drone'; unitId: string; droneKind: 'drone_recon' | 'drone_ew'; targetOrbit?: KeplerOrbit }
  | { type: 'fire_munition'; unitId: string; targetTrackId: string; profileId: 'light_interceptor' | 'heavy_torpedo'; count: number; coldCoast: boolean }
  | { type: 'update_route'; routeId: string; patch: Partial<Omit<LogisticsRoute, 'id' | 'faction'>> }
  | { type: 'queue_build'; kind: 'freighter_cap' | 'outpost' | 'relay_depot' | UnitEntity['kind'] | 'wonder_slot'; targetRef?: string | Vec2 };

export interface FactionSnapshot {
  tick: number;
  gameTimeSec: number;
  faction: FactionId;
  resources: Record<ResourceType, number>;
  freighterCap: number;
  freightersInFlight: number;
  celestials: Array<{ id: string; pos: Vec2; vel: Vec2 }>;
  ownUnits: UnitEntity[];
  ownMunitions: MunitionEntity[];
  tracks: SensorTrack[];     // 权威迷雾裁剪后的敌方感知列表
  routes: LogisticsRoute[];
  ownWonder: WonderSlot[];
  enemyWonderPublicProgress: number; // 敌方奇观已公开观测完工数（或受侦察限制）
  vfxEvents: Array<{ kind: 'laser' | 'ciws' | 'explosion' | 'burn_flash'; from: Vec2; to?: Vec2; intensity: number }>;
  winner?: FactionId | null;
}
```

---

## 3. 关键物理与算法实现约定

### 3.1 二体开普勒引擎与数值稳定性
- **归一化内部单位**：物理引擎内部建议使用 **`AU` 与 `游戏秒 (s)`** 作为基准，定义太阳标准引力参数为 `MU_SUN = 4 * π² / (252²)`（即 `1 AU` 圆轨道周期精确为 `252 s`），同时在 UI 展示换算为人类直观的 `km/s` 与 `MM:SS`。
- **近圆轨道退化处理**：在由状态向量 `(r, v)` 反算 `KeplerOrbit` 时，当偏心率 `e < 1e-5` 时，直接钳位为 `e = 0` 并固定 `omega = 0`，将平近点角直接取当前真近点角/相位角，避免 `acos` 数值 NaN 溢出。
- **牛顿迭代解开普勒方程**：求解 `M = E - e * sin(E)`（偏心近点角 `E`），固定最多 6 次牛顿-拉弗森迭代（偏心率限制 `< 0.92`），精度达 `1e-10` 且耗时恒定。
- **前端大坐标渲染抖动消除**：渲染管线在任何绘制前，先以双精度计算相对坐标：
  ```typescript
  const screenX = (worldPos.x - cameraCenter.x) * pixelsPerAu + canvasWidth * 0.5;
  const screenY = (worldPos.y - cameraCenter.y) * pixelsPerAu + canvasHeight * 0.5;
  ```

### 3.2 三层轨道转移解算器（`packages/shared/src/transfer`）
1. **解析层（霍曼 / 双椭圆逼近）**：针对“进入目标轨道”，计算同心/近同轴椭圆的切点双脉冲方案，作为 `fuel` 基准。
2. **兰伯特有限步迭代层（参考 CoaDE 分段逼近思想）**：针对“交会/拦截目标”，在未来 `[0, 1.5 * T_synodic]` 内按粗网格采样出发时间 `t0` 与飞行时间 `dt`，对候选 `(r1(t0), r2(t0 + dt))` 使用 2~3 次迭代的通用变量法或打靶修正求解所需双脉冲 `Δv1 + Δv2`：
   - `fuel`：取可行解中 `|Δv1| + |Δv2|` 最小者；
   - `fast`：在允许消耗飞船剩余 `Δv` 的约束下取 `t0 + dt` 最早者；
   - `stealth`：
     - **核推**：只保留 `t0` 时刻处于天体视线遮挡区（相对敌母港与已知敌前哨）内的候选窗口；
     - **电推**：沿当前与目标轨道参数做低推力切向连续推力微步积分预演（约 30~60 步积分，耗时 < 1ms）。
3. **Bingo Δv 返航估算**：对每条转移方案的落点状态，快速估算返回最近友方补给站/油船的最小霍曼级 Δv（带 `1.15x` 安全余量系数），产出 `safe / amber / red` 三态告警。

### 3.3 传感器探测、视差测距与压制模型
- **被动红外（IR）信噪比**：`SNR_ir ∝ (baseHeat + thrustPower * propulsionIrFactor + radiatorRadiation + laserHeat) / R² / solarBackgroundNoise(pos)`；受视线遮挡截断。
- **被动光学（Optical）**：先检测目标是否落在任意天体本影锥内（是则信号 `= 0`）；否则按 `(sunFlux(pos) * crossSection * albedo) / R²` 与观测者望向太阳夹角的眩光衰减共同结算。
- **主动雷达与 ESM 不对称**：
  - 雷达回波：`SNR_radar ∝ (radarPower * rcs) / R⁴`（可穿透冷漂）。
  - ESM 截获：`SNR_esm ∝ radarPower / R²`（远超雷达回波有效半径）。
- **发散激光探测（LADAR）**：仅检验“目标是否落入长距离极短锥角 `[angle - width/2, angle + width/2]` 且距离 `<= maxLadarRange` 且未被遮挡”；忽略射频噪声干扰，直接给予 `confirmed` 精度，同时向被扫描目标生成一条指向扫掠源方向的告警事件。
- **多平台视差与干扰退化**：
  - 若同一目标同时被 `>= 2` 个不同空间基线（夹角 `> 3°`）的被动传感器或无人机中继捕获 `Bearing`，误差椭圆长短轴按几何交汇自动收缩至 `confirmed`；
  - 若目标方向存在生效中的 `jammerActive`（含电战无人机），射频雷达与无线电定位的 `errorRadiusMajorAu` 乘以干扰倍增系数（如 `4x–10x`），强制降级为 `uncertain` 并扰乱依赖雷达导引头的在飞弹药。

### 3.4 近战火炮、近防（CIWS）与激光拦截结算
- **激光点防与烧蚀（10Hz Tick）**：对进入射程的敌方导弹或飞船，计算 `power = baseLaserPower * attenuation(dist)`，按热容量扣减己方热沉余量；每 Tick 累计伤害达到导弹 HP 即击落，若指向敌舰可按概率损伤敌方 `sensors` 或 `thermal` 子系统。
- **纯数值近防（CIWS）**：当弹药突入目标近防半径且未被激光拦截时，一次性判定拦截概率：
  ```text
  pIntercept = clamp(baseCiws * defenderThermalFactor - attackerSpeedPenalty - salvoSaturationPenalty, 0.05, 0.90)
  ```
- **纯数值近战火炮**：两敌对舰船进入近战交会半径时，按双方火炮数值 `gunDps * subsystemWeaponFactor(weapons) * dt` 互相持续扣减 HP，无需弹道模拟。

---

## 4. 两人零阻塞并行协作规范

为确保 2 名开发者能同时高效推进，不互相卡死在未完成模块上，采用如下工作流：

1. **契约先行，冻结 `packages/shared`（M0 阶段共修）**：
   - 第 1~2 天双人合力落地 `SW-01 ~ SW-03`，把 `packages/shared` 中的类型、WebSocket 消息格式、静态天体与数值表冻结为双方共同遵循的 API。
   - M1 之后如需改动 `packages/shared` 公共接口，必须通过 PR 双人 review 确认。
2. **Dev A（仿真与后端主程）独立推进策略**：
   - **不依赖浏览器/UI**：在 `packages/server` 中内置 `HeadlessMatchRunner`，直接向引擎喂入脚本化 `PlayerCommand[]` 并推进数千个 Tick，结合 Vitest 断言轨控 Δv、迷雾隐藏、弹药拦截、货船池化运力增减与奇观完工胜利。
3. **Dev B（前端与交互主程）独立推进策略**：
   - **不依赖后端 WebSocket 服务**：定义统一的客户端数据源接口 `IWorldProvider`（产出 `FactionSnapshot` 订阅流并接收 `PlayerCommand`）。
   - 在前端优先实现 `MockWorldProvider`：直接调用 `packages/shared` 的星历与转移解算纯函数，结合若干内置脚本敌方 `SensorTrack[]` 与模拟弹药轨迹，即可在零后端的情况下完整开发与自测太阳系渲染、轨道拖拽、Bingo 预警、4 级航迹可视化、像素 VFX 与 CRT 风格。
4. **Git 分支与提交流程**：
   - 分支命名：`feat/sw-<编号>-<简述>`（例如 `feat/sw-04-kepler-engine`）。
   - 每次合并回 `master` 前必须保证 `pnpm -r typecheck` 与 `pnpm -r test` 全绿。
