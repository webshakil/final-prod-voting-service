import Joi from 'joi';

// Vote validation schema
export const voteSchema = Joi.object({
  electionId: Joi.number().integer().required(),
  answers: Joi.object().pattern(
    Joi.number(),
    Joi.alternatives().try(
      Joi.array().items(Joi.number()), // For approval voting
      Joi.number(), // For plurality
      Joi.array().items(Joi.object({
        optionId: Joi.number(),
        rank: Joi.number()
      })), // For ranked choice
      Joi.string() // For open text
    )
  ).required()
});

// Wallet deposit schema
export const depositSchema = Joi.object({
  amount: Joi.number().positive().min(1).max(1000000).required(),
  paymentMethod: Joi.string().valid('stripe', 'paddle').required(),
  currency: Joi.string().length(3).default('USD')
});

// Wallet withdrawal schema
export const withdrawalSchema = Joi.object({
  amount: Joi.number().positive().min(10).required(),
  paymentMethod: Joi.string().valid('stripe', 'paddle', 'bank_transfer').required(),
  paymentDetails: Joi.object().required()
});

// Lottery configuration schema
export const lotteryConfigSchema = Joi.object({
  electionId: Joi.number().integer().required(),
  rewardType: Joi.string().valid('monetary', 'non_monetary', 'projected_revenue').required(),
  rewardAmount: Joi.number().when('rewardType', {
    is: 'monetary',
    then: Joi.number().positive().required()
  }),
  rewardDescription: Joi.string().when('rewardType', {
    is: 'non_monetary',
    then: Joi.string().required()
  }),
  winnerCount: Joi.number().integer().min(1).max(100).required(),
  prizeDistribution: Joi.array().items(
    Joi.object({
      rank: Joi.number().integer().required(),
      percentage: Joi.number().min(0).max(100).required()
    })
  )
});

export default {
  voteSchema,
  depositSchema,
  withdrawalSchema,
  lotteryConfigSchema
};