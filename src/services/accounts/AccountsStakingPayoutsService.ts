// Copyright 2017-2024 Parity Technologies (UK) Ltd.
// This file is part of Substrate API Sidecar.
//
// Substrate API Sidecar is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import type { ApiDecoration } from '@polkadot/api/types';
import type {
	DeriveEraExposure,
	DeriveEraExposureNominating,
	DeriveEraNominatorExposure,
	DeriveEraValidatorExposure,
} from '@polkadot/api-derive/staking/types';
import type { Option, StorageKey, u32 } from '@polkadot/types';
import type {
	AccountId,
	BalanceOf,
	BlockHash,
	EraIndex,
	Perbill,
	StakingLedger,
	StakingLedgerTo240,
} from '@polkadot/types/interfaces';
import type {
	PalletStakingEraRewardPoints,
	PalletStakingExposure,
	PalletStakingStakingLedger,
} from '@polkadot/types/lookup';
import { CalcPayout } from '@substrate/calc';
import { BadRequest } from 'http-errors';

import type { IAccountStakingPayouts, IEraPayouts, IPayout } from '../../types/responses';
import { AbstractService } from '../AbstractService';

/**
 * Copyright 2024 via polkadot-js/api
 * The following code was adopted by https://github.com/polkadot-js/api/blob/3bdf49b0428a62f16b3222b9a31bfefa43c1ca55/packages/api-derive/src/staking/erasExposure.ts.
 */
type KeysAndExposures = [StorageKey<[EraIndex, AccountId]>, PalletStakingExposure][];

/**
 * General information about an era, in tuple form because we initially get it
 * by destructuring a Promise.all(...)
 */
type IErasGeneral = [DeriveEraExposure, PalletStakingEraRewardPoints, Option<BalanceOf>];

/**
 * Commission and staking ledger of a validator
 */
interface ICommissionAndLedger {
	commission: Perbill;
	validatorLedger?: PalletStakingStakingLedger;
}

/**
 * All the data we need to calculate payouts for an address at a given era.
 */
interface IEraData {
	deriveEraExposure: DeriveEraExposure;
	eraRewardPoints: PalletStakingEraRewardPoints;
	erasValidatorRewardOption: Option<BalanceOf>;
	exposuresWithCommission?: (ICommissionAndLedger & {
		validatorId: string;
	})[];
	eraIndex: EraIndex;
}

export class AccountsStakingPayoutsService extends AbstractService {
	/**
	 * Fetch and derive payouts for `address`.
	 *
	 * @param hash `BlockHash` to make call at
	 * @param address address of the _Stash_  account to get the payouts of
	 * @param depth number of eras to query at and below the specified era
	 * @param era the most recent era to query
	 * @param unclaimedOnly whether or not to only show unclaimed payouts
	 * @param currentEra The current era
	 * @param historicApi Historic api for querying past blocks
	 */
	async fetchAccountStakingPayout(
		hash: BlockHash,
		address: string,
		depth: number,
		era: number,
		unclaimedOnly: boolean,
		currentEra: number,
		historicApi: ApiDecoration<'promise'>,
	): Promise<IAccountStakingPayouts> {
		const { api } = this;
		const { number } = await api.rpc.chain.getHeader(hash);

		/**
		 * Given https://github.com/polkadot-js/api/issues/5232,
		 * polkadot-js, and substrate treats historyDepth as a consts. In order
		 * to maintain historical integrity we need to make a check to cover both the
		 * storage query and the consts.
		 */
		let historyDepth: u32 = api.registry.createType('u32', 84);
		if (historicApi.consts.staking.historyDepth) {
			historyDepth = historicApi.consts.staking.historyDepth;
		} else if (historicApi.query.staking.historyDepth) {
			historyDepth = await historicApi.query.staking.historyDepth<u32>();
		} else if (currentEra < 518) {
			historyDepth = api.registry.createType('u32', 0);
		}

		// Information is kept for eras in `[current_era - history_depth; current_era]`
		if (historyDepth.toNumber() !== 0 && depth > historyDepth.toNumber()) {
			throw new BadRequest('Must specify a depth less than history_depth');
		}
		if (era - (depth - 1) < currentEra - historyDepth.toNumber() && historyDepth.toNumber() !== 0) {
			// In scenarios where depth is not > historyDepth, but the user specifies an era
			// and historyDepth combo that would lead to querying eras older than history depth
			throw new BadRequest(
				'Must specify era and depth such that era - (depth - 1) is less ' +
				'than or equal to current_era - history_depth.',
			);
		}

		const at = {
			height: number.unwrap().toString(10),
			hash,
		};

		// User friendly - we don't error if the user specified era & depth combo <= 0, instead just start at 0
		const startEra = Math.max(0, era - (depth - 1));

		// Fetch general data about the era
		const allErasGeneral = await this.fetchAllErasGeneral(historicApi, startEra, era, at.height);

		// With the general data, we can now fetch the commission of each validator `address` nominates
		const allErasCommissions = await this.fetchAllErasCommissions(
			historicApi,
			address,
			startEra,
			// Create an array of `DeriveEraExposure`
			allErasGeneral.map((eraGeneral) => eraGeneral[0]),
		).catch((err: Error) => {
			throw this.createHttpErrorForAddr(address, err);
		});

		// Group together data by Era so we can easily associate parts that are used congruently downstream
		const allEraData = allErasGeneral.map(
			([deriveEraExposure, eraRewardPoints, erasValidatorRewardOption]: IErasGeneral, idx: number): IEraData => {
				const eraCommissions = allErasCommissions[idx];

				const nominatedExposures = this.deriveNominatedExposures(address, deriveEraExposure);

				// Zip the `validatorId` with its associated `commission`, making the data easier to reason
				// about downstream
				const exposuresWithCommission = nominatedExposures?.map(({ validatorId }, idx) => {
					return {
						validatorId,
						...eraCommissions[idx],
					};
				});

				return {
					deriveEraExposure,
					eraRewardPoints,
					erasValidatorRewardOption,
					exposuresWithCommission,
					eraIndex: historicApi.registry.createType('EraIndex', idx + startEra),
				};
			},
		);

		return {
			at,
			erasPayouts: allEraData.map((eraData) => this.deriveEraPayouts(address, unclaimedOnly, eraData)),
		};
	}

	/**
	 * Fetch general info about eras in the inclusive range `startEra` .. `era`.
	 *
	 * @param api `ApiPromise`
	 * @param hash `BlockHash` to make call at
	 * @param startEra first era to get data for
	 * @param era the last era to get data for
	 */
	async fetchAllErasGeneral(
		historicApi: ApiDecoration<'promise'>,
		startEra: number,
		era: number,
		blockNumber: string,
	): Promise<any[]> {
		const allDeriveQuerys: Promise<IErasGeneral | any>[] = [];
		let block = Number(blockNumber);
		for (let e = startEra; e <= era; e += 1) {

			if (historicApi.query.staking.erasRewardPoints) {

				const eraIndex = historicApi.registry.createType('EraIndex', e);
				console.log(eraIndex)

				const eraGeneralTuple = Promise.all([
					this.deriveEraExposure(historicApi, eraIndex),
					historicApi.query.staking.erasRewardPoints(eraIndex),
					historicApi.query.staking.erasValidatorReward(eraIndex),
				]);

				allDeriveQuerys.push(eraGeneralTuple);
			} else {
				const sessionDuration = historicApi.consts.staking.sessionsPerEra.toNumber();
				const epochDuration = historicApi.consts.babe.epochDuration.toNumber();
				const eraDurationInBlocks = sessionDuration * epochDuration;
				
				const points = this.fetchHistoricRewardPoints(block);
				const erass = await historicApi.query.staking.currentEra();
				console.log(erass.toHuman())

				block = block - eraDurationInBlocks
				console.log(sessionDuration)
				console.log(epochDuration)
				console.log(eraDurationInBlocks)

				// console.log('sessions', historicApi.consts.staking.sessionsPerEra.toHuman())
				// const eraIndex = historicApi.registry.createType('EraIndex', e);

				const eraGeneralTuple = Promise.all([
					// this.deriveEraExposure(historicApi, eraIndex),
					points,
					// historicApi.query.staking.erasValidatorReward(eraIndex)

				])

				console.log((await points).toHuman())
				allDeriveQuerys.push(eraGeneralTuple);

			}
		}
		return Promise.all(allDeriveQuerys);

	}

	async fetchHistoricRewardPoints(
		blockNumber: number,
	): Promise<any> {
		let hash = await this.api.rpc.chain.getBlockHash(blockNumber);
		const historicApi = await this.api.at(hash);
		return historicApi.query.staking.currentEraPointsEarned();

	}

	/**
	 * Fetch the commission & staking ledger for each `validatorId` in `deriveErasExposures`.
	 *
	 * @param api `ApiPromise`
	 * @param hash `BlockHash` to make call at
	 * @param address address of the _Stash_  account to get the payouts of
	 * @param startEra first era to get data for
	 * @param deriveErasExposures exposures per era for `address`
	 */
	fetchAllErasCommissions(
		historicApi: ApiDecoration<'promise'>,
		address: string,
		startEra: number,
		deriveErasExposures: DeriveEraExposure[],
	): Promise<ICommissionAndLedger[][]> {
		// Cache StakingLedger to reduce redundant queries to node
		const validatorLedgerCache: { [id: string]: PalletStakingStakingLedger } = {};

		const allErasCommissions = deriveErasExposures.map((deriveEraExposure, idx) => {
			const currEra = idx + startEra;

			const nominatedExposures = this.deriveNominatedExposures(address, deriveEraExposure);

			if (!nominatedExposures) {
				return [];
			}

			const singleEraCommissions = nominatedExposures.map(({ validatorId }) =>
				this.fetchCommissionAndLedger(historicApi, validatorId, currEra, validatorLedgerCache),
			);

			return Promise.all(singleEraCommissions);
		});

		return Promise.all(allErasCommissions);
	}

	/**
	 * Derive all the payouts for `address` at `era`.
	 *
	 * @param address address of the _Stash_  account to get the payouts of
	 * @param era the era to query
	 * @param eraData data about the address and era we are calculating payouts for
	 */
	deriveEraPayouts(
		address: string,
		unclaimedOnly: boolean,
		{ deriveEraExposure, eraRewardPoints, erasValidatorRewardOption, exposuresWithCommission, eraIndex }: IEraData,
	): IEraPayouts | { message: string } {
		if (!exposuresWithCommission) {
			return {
				message: `${address} has no nominations for the era ${eraIndex.toString()}`,
			};
		}

		if (erasValidatorRewardOption.isNone) {
			return {
				message: `No ErasValidatorReward for the era ${eraIndex.toString()}`,
			};
		}

		const totalEraRewardPoints = eraRewardPoints.total;
		const totalEraPayout = erasValidatorRewardOption.unwrap();
		const calcPayout = CalcPayout.from_params(totalEraRewardPoints.toNumber(), totalEraPayout.toString(10));

		// Iterate through validators that this nominator backs and calculate payouts for the era
		const payouts: IPayout[] = [];
		for (const { validatorId, commission: validatorCommission, validatorLedger } of exposuresWithCommission) {
			const totalValidatorRewardPoints = this.extractTotalValidatorRewardPoints(eraRewardPoints, validatorId);

			if (!totalValidatorRewardPoints || totalValidatorRewardPoints?.toNumber() === 0) {
				// Nothing to do if there are no reward points for the validator
				continue;
			}

			const { totalExposure, nominatorExposure } = this.extractExposure(address, validatorId, deriveEraExposure);

			if (nominatorExposure === undefined) {
				// This should not happen once at this point, but here for safety
				continue;
			}

			if (!validatorLedger) {
				continue;
			}

			/**
			 * Check if the reward has already been claimed.
			 *
			 * It is important to note that the following examines types that are both current and historic.
			 * When going back far enough in certain chains types such as `StakingLedgerTo240` are necessary for grabbing
			 * any reward data.
			 */
			let indexOfEra: number;
			if (validatorLedger.legacyClaimedRewards) {
				indexOfEra = validatorLedger.legacyClaimedRewards.indexOf(eraIndex);
			} else if ((validatorLedger as unknown as StakingLedger).claimedRewards) {
				indexOfEra = (validatorLedger as unknown as StakingLedger).claimedRewards.indexOf(eraIndex);
			} else if ((validatorLedger as unknown as StakingLedgerTo240).lastReward) {
				const lastReward = (validatorLedger as unknown as StakingLedgerTo240).lastReward;
				if (lastReward.isSome) {
					indexOfEra = (validatorLedger as unknown as StakingLedgerTo240).lastReward.unwrap().toNumber();
				} else {
					continue;
				}
			} else {
				continue;
			}
			const claimed: boolean = Number.isInteger(indexOfEra) && indexOfEra !== -1;
			if (unclaimedOnly && claimed) {
				continue;
			}

			const nominatorStakingPayout = calcPayout.calc_payout(
				totalValidatorRewardPoints.toNumber(),
				validatorCommission.toNumber(),
				nominatorExposure.unwrap().toString(10),
				totalExposure.unwrap().toString(10),
				address === validatorId,
			);

			payouts.push({
				validatorId,
				nominatorStakingPayout,
				claimed,
				totalValidatorRewardPoints,
				validatorCommission,
				totalValidatorExposure: totalExposure.unwrap(),
				nominatorExposure: nominatorExposure.unwrap(),
			});
		}

		return {
			era: eraIndex,
			totalEraRewardPoints,
			totalEraPayout,
			payouts,
		};
	}

	/**
	 * Fetch the `commission` and `StakingLedger` of `validatorId`.
	 *
	 * @param api
	 * @param validatorId accountId of a validator's _Stash_  account
	 * @param era the era to query
	 * @param hash `BlockHash` to make call at
	 * @param validatorLedgerCache object mapping validatorId => StakingLedger to limit redundant queries
	 */
	private async fetchCommissionAndLedger(
		historicApi: ApiDecoration<'promise'>,
		validatorId: string,
		era: number,
		validatorLedgerCache: { [id: string]: PalletStakingStakingLedger },
	): Promise<ICommissionAndLedger> {
		let commission;
		let validatorLedger;
		if (validatorId in validatorLedgerCache) {
			validatorLedger = validatorLedgerCache[validatorId];
			const prefs = await historicApi.query.staking.erasValidatorPrefs(era, validatorId);

			commission = prefs.commission.unwrap();
		} else {
			const [prefs, validatorControllerOption] = await Promise.all([
				historicApi.query.staking.erasValidatorPrefs(era, validatorId),
				historicApi.query.staking.bonded(validatorId),
			]);

			commission = prefs.commission.unwrap();

			if (validatorControllerOption.isNone) {
				return {
					commission,
				};
			}

			const validatorLedgerOption = await historicApi.query.staking.ledger(validatorControllerOption.unwrap());

			if (validatorLedgerOption.isNone) {
				return {
					commission,
				};
			}

			validatorLedger = validatorLedgerOption.unwrap();
			validatorLedgerCache[validatorId] = validatorLedger;
		}

		return { commission, validatorLedger };
	}

	/**
	 * Copyright 2024 via polkadot-js/api
	 * The following code was adopted by https://github.com/polkadot-js/api/blob/3bdf49b0428a62f16b3222b9a31bfefa43c1ca55/packages/api-derive/src/staking/erasExposure.ts.
	 *
	 * The original version uses the base ApiDerive implementation which does not include the ApiDecoration implementation.
	 * It is required in this version to query older blocks for their historic data.
	 *
	 * @param historicApi
	 * @param eraIndex
	 */
	private async deriveEraExposure(
		historicApi: ApiDecoration<'promise'>,
		eraIndex: EraIndex,
	): Promise<DeriveEraExposure> {
		function mapStakers(era: EraIndex, stakers: KeysAndExposures): DeriveEraExposure {
			const nominators: DeriveEraNominatorExposure = {};
			const validators: DeriveEraValidatorExposure = {};

			stakers.forEach(([key, exposure]): void => {
				const validatorId = key.args[1].toString();

				validators[validatorId] = exposure;

				exposure.others.forEach(({ who }, validatorIndex): void => {
					const nominatorId = who.toString();

					nominators[nominatorId] = nominators[nominatorId] || [];
					nominators[nominatorId].push({ validatorId, validatorIndex });
				});
			});

			return { era, nominators, validators };
		}

		const eraExposure = await historicApi.query.staking.erasStakersClipped.entries(eraIndex);

		return mapStakers(eraIndex, eraExposure);
	}

	/**
	 * Extract the reward points of `validatorId` from `EraRewardPoints`.
	 *
	 * @param eraRewardPoints
	 * @param validatorId accountId of a validator's _Stash_  account
	 * */
	private extractTotalValidatorRewardPoints(eraRewardPoints: PalletStakingEraRewardPoints, validatorId: string) {
		// Ideally we would just use the map's `get`, but that does not seem to be working here
		for (const [id, points] of eraRewardPoints.individual.entries()) {
			if (id.toString() === validatorId) {
				return points;
			}
		}

		return;
	}

	/**
	 * Extract the exposure of `address` and `totalExposure`
	 * from polkadot-js's `deriveEraExposure`.
	 *
	 * @param address address of the _Stash_  account to get the exposure of behind `validatorId`
	 * @param validatorId accountId of a validator's _Stash_  account
	 * @param deriveEraExposure
	 */
	private extractExposure(address: string, validatorId: string, deriveEraExposure: DeriveEraExposure) {
		// Get total stake behind validator
		const totalExposure = deriveEraExposure.validators[validatorId].total;

		// Get nominators stake behind validator
		const exposureAllNominators = deriveEraExposure.validators[validatorId].others;

		const nominatorExposure =
			address === validatorId // validator is also the nominator we are getting payouts for
				? deriveEraExposure.validators[address].own
				: exposureAllNominators.find((exposure) => exposure.who.toString() === address)?.value;

		return {
			totalExposure,
			nominatorExposure,
		};
	}

	/**
	 * Derive the list of validators nominated by `address`. Note: we count validators as nominating
	 * themself.
	 *
	 * @param address address of the _Stash_  account to get the payouts of
	 * @param deriveEraExposure result of deriveEraExposure
	 */
	deriveNominatedExposures(
		address: string,
		deriveEraExposure: DeriveEraExposure,
	): DeriveEraExposureNominating[] | undefined {
		let nominatedExposures: DeriveEraExposureNominating[] = deriveEraExposure.nominators[address] ?? [];
		if (deriveEraExposure.validators[address]) {
			// We treat an `address` that is a validator as nominating itself
			nominatedExposures = nominatedExposures.concat({
				validatorId: address,
				// We put in an arbitrary number because we do not use the index
				validatorIndex: 9999,
			});
		}

		return nominatedExposures;
	}
}
