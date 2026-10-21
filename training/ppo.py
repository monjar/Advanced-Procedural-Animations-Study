"""
Proximal Policy Optimization (Schulman et al., 2017), in the shape legged_gym/rsl_rl use for locomotion:
Gaussian policy with a state-independent learnable std, GAE(λ), clipped surrogate and clipped value loss,
and a learning rate adapted to hold the KL divergence between updates near a target.
"""

from __future__ import annotations

import torch
from torch import nn


def mlp(sizes: list[int]) -> nn.Sequential:
    layers: list[nn.Module] = []
    for i in range(len(sizes) - 1):
        layers.append(nn.Linear(sizes[i], sizes[i + 1]))
        if i < len(sizes) - 2:
            layers.append(nn.ELU())
    return nn.Sequential(*layers)


class ActorCritic(nn.Module):
    def __init__(self, num_obs: int, num_act: int, hidden: list[int], init_std: float = 1.0):
        super().__init__()
        self.actor = mlp([num_obs, *hidden, num_act])
        self.critic = mlp([num_obs, *hidden, 1])
        self.log_std = nn.Parameter(torch.full((num_act,), float(torch.log(torch.tensor(init_std)))))

    def dist(self, obs: torch.Tensor) -> torch.distributions.Normal:
        return torch.distributions.Normal(self.actor(obs), self.log_std.exp().expand(obs.shape[0], -1))


class RolloutBuffer:
    def __init__(self, steps: int, envs: int, num_obs: int, num_act: int):
        self.obs = torch.zeros(steps, envs, num_obs)
        self.actions = torch.zeros(steps, envs, num_act)
        self.log_probs = torch.zeros(steps, envs)
        self.values = torch.zeros(steps, envs)
        self.rewards = torch.zeros(steps, envs)
        self.dones = torch.zeros(steps, envs)
        self.mu = torch.zeros(steps, envs, num_act)
        self.sigma = torch.zeros(steps, envs, num_act)
        self.returns = torch.zeros(steps, envs)
        self.advantages = torch.zeros(steps, envs)
        self.step = 0

    def compute_returns(self, last_values: torch.Tensor, gamma: float, lam: float) -> None:
        adv = torch.zeros_like(last_values)
        for t in reversed(range(self.obs.shape[0])):
            next_values = last_values if t == self.obs.shape[0] - 1 else self.values[t + 1]
            not_done = 1.0 - self.dones[t]
            delta = self.rewards[t] + gamma * next_values * not_done - self.values[t]
            adv = delta + gamma * lam * not_done * adv
            self.returns[t] = adv + self.values[t]
        self.advantages = self.returns - self.values
        self.advantages = (self.advantages - self.advantages.mean()) / (self.advantages.std() + 1e-8)


class PPO:
    def __init__(
        self,
        ac: ActorCritic,
        lr: float = 1e-3,
        epochs: int = 5,
        minibatches: int = 4,
        clip: float = 0.2,
        value_coef: float = 1.0,
        entropy_coef: float = 0.01,
        gamma: float = 0.99,
        lam: float = 0.95,
        max_grad_norm: float = 1.0,
        desired_kl: float = 0.01,
    ):
        self.ac = ac
        self.lr = lr
        self.opt = torch.optim.Adam(ac.parameters(), lr=lr)
        self.epochs, self.minibatches, self.clip = epochs, minibatches, clip
        self.value_coef, self.entropy_coef = value_coef, entropy_coef
        self.gamma, self.lam = gamma, lam
        self.max_grad_norm, self.desired_kl = max_grad_norm, desired_kl

    @torch.no_grad()
    def act(self, obs: torch.Tensor, buf: RolloutBuffer) -> torch.Tensor:
        d = self.ac.dist(obs)
        a = d.sample()
        t = buf.step
        buf.obs[t] = obs
        buf.actions[t] = a
        buf.log_probs[t] = d.log_prob(a).sum(-1)
        buf.values[t] = self.ac.critic(obs).squeeze(-1)
        buf.mu[t] = d.mean
        buf.sigma[t] = d.stddev
        return a

    def record(self, buf: RolloutBuffer, rewards: torch.Tensor, dones: torch.Tensor, timeouts: torch.Tensor) -> None:
        t = buf.step
        # Bootstrap episodes cut by the time limit: they did not end, the clock did.
        buf.rewards[t] = rewards + self.gamma * buf.values[t] * timeouts
        buf.dones[t] = dones
        buf.step += 1

    def update(self, buf: RolloutBuffer, last_obs: torch.Tensor) -> dict[str, float]:
        with torch.no_grad():
            last_values = self.ac.critic(last_obs).squeeze(-1)
        buf.compute_returns(last_values, self.gamma, self.lam)
        n = buf.obs.shape[0] * buf.obs.shape[1]
        flat = lambda x: x.reshape(n, *x.shape[2:])  # noqa: E731
        obs, actions, old_lp, old_v = flat(buf.obs), flat(buf.actions), flat(buf.log_probs), flat(buf.values)
        returns, adv, old_mu, old_sigma = flat(buf.returns), flat(buf.advantages), flat(buf.mu), flat(buf.sigma)
        stats = {"policy_loss": 0.0, "value_loss": 0.0, "entropy": 0.0, "kl": 0.0}
        count = 0
        mb = n // self.minibatches
        for _ in range(self.epochs):
            perm = torch.randperm(n)
            for k in range(self.minibatches):
                idx = perm[k * mb : (k + 1) * mb]
                d = self.ac.dist(obs[idx])
                lp = d.log_prob(actions[idx]).sum(-1)
                entropy = d.entropy().sum(-1).mean()
                with torch.no_grad():
                    # KL(old || new) between diagonal Gaussians; adapts the learning rate.
                    sigma, mu = d.stddev, d.mean
                    kl = torch.sum(
                        torch.log(sigma / old_sigma[idx] + 1e-5)
                        + (old_sigma[idx] ** 2 + (old_mu[idx] - mu) ** 2) / (2 * sigma**2)
                        - 0.5,
                        dim=-1,
                    ).mean()
                    if kl > self.desired_kl * 2:
                        self.lr = max(1e-5, self.lr / 1.5)
                    elif 0 < kl < self.desired_kl / 2:
                        self.lr = min(1e-2, self.lr * 1.5)
                    for g in self.opt.param_groups:
                        g["lr"] = self.lr
                ratio = torch.exp(lp - old_lp[idx])
                a = adv[idx]
                policy_loss = torch.max(-a * ratio, -a * torch.clamp(ratio, 1 - self.clip, 1 + self.clip)).mean()
                v = self.ac.critic(obs[idx]).squeeze(-1)
                v_clipped = old_v[idx] + (v - old_v[idx]).clamp(-self.clip, self.clip)
                value_loss = torch.max((v - returns[idx]) ** 2, (v_clipped - returns[idx]) ** 2).mean()
                loss = policy_loss + self.value_coef * value_loss - self.entropy_coef * entropy
                self.opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.ac.parameters(), self.max_grad_norm)
                self.opt.step()
                stats["policy_loss"] += policy_loss.item()
                stats["value_loss"] += value_loss.item()
                stats["entropy"] += entropy.item()
                stats["kl"] += kl.item()
                count += 1
        buf.step = 0
        return {k: v / count for k, v in stats.items()} | {"lr": self.lr}
