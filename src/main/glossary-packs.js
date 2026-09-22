'use strict';
/**
 * 术语表起步包：按课程方向预置的常见术语，一键导入。
 *
 * 术语表原先是空的，得自己一条条加。这里给几份按方向分好的，开箱就能用。
 *
 * ── 选词原则（这是这个文件最要紧的地方）──
 *
 * 术语表是子串替换，门槛是「英文里出现这个词」且「译文里出现它的已知错法」。
 * 日常英语里也常见的词（policy、agent、state、attention、model…）放进来，
 * 会把普通句子也改掉——「政府出台了新政策」里有 policy，就会被改成「新策略」。
 *
 * 所以：
 *   1. 优先收**多词术语**和**只在技术语境出现的词**（backpropagation、overfitting）；
 *   2. 常见词只放进**明确写了适用范围**的包里（强化学习包的 policy / agent / state / reward），
 *      包的说明里直接告诉你「只在上这门课时导入」；
 *   3. 跨方向有歧义的词不收：kernel（系统里是内核、机器学习里是核函数）、
 *      inference（统计里是推断、深度学习里是推理）、token（NLP 里是词元、系统里是令牌）。
 * 测试里有一条断言守着第 2 条：常见词出现在没有写适用范围的包里就失败。
 *
 * 格式和「批量粘贴」完全一样（走同一个解析器），`#` 开头的行是说明。
 */

const PACKS = [
  {
    id: 'ml',
    name: '机器学习基础',
    scope: '任何机器学习、数据科学相关的课都可以放心导入：只收了多词术语和纯技术词。',
    text: `
gradient descent = 梯度下降
stochastic gradient descent = 随机梯度下降
learning rate = 学习率
loss function = 损失函数
cost function = 代价函数
objective function = 目标函数
overfitting = 过拟合
underfitting = 欠拟合
regularization = 正则化
cross-validation = 交叉验证
training set = 训练集
validation set = 验证集
test set = 测试集
hyperparameter = 超参数
feature engineering = 特征工程
bias-variance tradeoff = 偏差-方差权衡
decision tree = 决策树
random forest = 随机森林
support vector machine = 支持向量机
logistic regression = 逻辑回归
linear regression = 线性回归
principal component analysis = 主成分分析
dimensionality reduction = 降维
confusion matrix = 混淆矩阵
supervised learning = 监督学习
unsupervised learning = 无监督学习
semi-supervised learning = 半监督学习
self-supervised learning = 自监督学习
`,
  },
  {
    id: 'dl',
    name: '深度学习',
    scope: '深度学习、计算机视觉相关的课。注意 transformer 会把「变压器」改成「Transformer 模型」，上电路课时别导入。',
    text: `
neural network = 神经网络
backpropagation = 反向传播
activation function = 激活函数
convolutional neural network = 卷积神经网络
recurrent neural network = 循环神经网络
batch normalization = 批归一化
layer normalization = 层归一化
# dropout 在中文教材里也常直接写英文；这里用最通行的「随机失活」
dropout = 随机失活
vanishing gradient = 梯度消失
exploding gradient = 梯度爆炸
residual connection = 残差连接
skip connection = 跳跃连接
attention mechanism = 注意力机制
self-attention = 自注意力
multi-head attention = 多头注意力
transformer = Transformer 模型
word embedding = 词嵌入
fine-tuning = 微调
pre-training = 预训练
transfer learning = 迁移学习
generative adversarial network = 生成对抗网络
autoencoder = 自编码器
variational autoencoder = 变分自编码器
diffusion model = 扩散模型
cross-entropy loss = 交叉熵损失
mini-batch = 小批量
epoch = 训练轮次
`,
  },
  {
    id: 'rl',
    name: '强化学习',
    scope: '只在上强化学习相关的课时导入。这个包收了 policy、agent、state、reward 这几个日常英语也常见的词，'
      + '会把含这些词的句子里的「政策」「特工」「国家」「奖金」改成「策略」「智能体」「状态」「奖励」——'
      + '在 RL 课上正是你要的，在别的课上就是误改。',
    text: `
reinforcement learning = 强化学习
# 下面四个是日常英语也常见的词，只在 RL 课上才该这么译（见包说明）
policy = 策略
agent = 智能体
state = 状态
reward = 奖励
value function = 价值函数
action-value function = 动作价值函数
reward function = 奖励函数
experience replay = 经验回放
replay buffer = 经验回放缓冲区
temporal difference = 时序差分
policy gradient = 策略梯度
actor-critic = 演员-评论家
markov decision process = 马尔可夫决策过程
discount factor = 折扣因子
bellman equation = 贝尔曼方程
q-learning = Q 学习
deep q-network = 深度 Q 网络
target network = 目标网络
on-policy = 同策略
off-policy = 异策略
state space = 状态空间
action space = 动作空间
exploration-exploitation = 探索-利用
`,
  },
  {
    id: 'nlp',
    name: '自然语言处理',
    scope: '自然语言处理、大模型相关的课。token 故意没收：在系统课里它是「令牌」。',
    text: `
natural language processing = 自然语言处理
large language model = 大语言模型
language model = 语言模型
tokenizer = 分词器
tokenization = 分词
byte-pair encoding = 字节对编码
in-context learning = 上下文学习
chain-of-thought = 思维链
prompt engineering = 提示工程
retrieval-augmented generation = 检索增强生成
named entity recognition = 命名实体识别
part-of-speech tagging = 词性标注
sequence-to-sequence = 序列到序列
beam search = 束搜索
perplexity = 困惑度
instruction tuning = 指令微调
reinforcement learning from human feedback = 基于人类反馈的强化学习
zero-shot = 零样本
few-shot = 少样本
`,
  },
  {
    id: 'sys',
    name: '计算机系统与分布式',
    scope: '操作系统、分布式系统、机器学习系统相关的课。kernel 故意没收：机器学习里它是「核函数」。',
    text: `
distributed system = 分布式系统
load balancing = 负载均衡
cache miss = 缓存未命中
race condition = 竞态条件
deadlock = 死锁
thread pool = 线程池
garbage collection = 垃圾回收
memory leak = 内存泄漏
consensus algorithm = 共识算法
eventual consistency = 最终一致性
fault tolerance = 容错
mutual exclusion = 互斥
context switch = 上下文切换
page fault = 缺页中断
throughput = 吞吐量
latency = 延迟
bandwidth = 带宽
virtual machine = 虚拟机
message queue = 消息队列
sharding = 分片
containerization = 容器化
data parallelism = 数据并行
model parallelism = 模型并行
pipeline parallelism = 流水线并行
mixed precision = 混合精度
`,
  },
];

/**
 * 日常英语里也常见的词。它们只能出现在「写了适用范围」的包里
 * （包说明里有「只在…时导入」）——测试靠这张表守住选词原则的第 2 条。
 */
const COMMON_WORDS = new Set([
  'policy', 'agent', 'state', 'reward', 'action', 'model', 'attention', 'value',
  'network', 'feature', 'training', 'learning', 'kernel', 'token', 'inference',
  'memory', 'thread', 'process', 'cache', 'lock', 'queue', 'loss', 'bias',
]);

function listPacks() {
  return PACKS.map((p) => ({ id: p.id, name: p.name, scope: p.scope }));
}

function packById(id) {
  return PACKS.find((p) => p.id === id) || null;
}

module.exports = { PACKS, COMMON_WORDS, listPacks, packById };
