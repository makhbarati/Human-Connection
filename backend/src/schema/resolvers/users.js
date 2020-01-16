import { neo4jgraphql } from 'neo4j-graphql-js'
import fileUpload from './fileUpload'
import { getNeode } from '../../bootstrap/neo4j'
import { UserInputError, ForbiddenError } from 'apollo-server'
import Resolver from './helpers/Resolver'
import log from './helpers/databaseLogger'
import createOrUpdateLocations from './users/location'

const neode = getNeode()

export const getBlockedUsers = async context => {
  const { neode } = context
  const userModel = neode.model('User')
  let blockedUsers = neode
    .query()
    .match('user', userModel)
    .where('user.id', context.user.id)
    .relationship(userModel.relationships().get('blocked'))
    .to('blocked', userModel)
    .return('blocked')
  blockedUsers = await blockedUsers.execute()
  blockedUsers = blockedUsers.records.map(r => r.get('blocked').properties)
  return blockedUsers
}

export const getBlockedByUsers = async context => {
  if (context.user.role === 'moderator' || context.user.role === 'admin') return []
  const { neode } = context
  const userModel = neode.model('User')
  let blockedByUsers = neode
    .query()
    .match('user', userModel)
    .relationship(userModel.relationships().get('blocked'))
    .to('blocked', userModel)
    .where('blocked.id', context.user.id)
    .return('user')
  blockedByUsers = await blockedByUsers.execute()
  blockedByUsers = blockedByUsers.records.map(r => r.get('user').properties)
  return blockedByUsers
}

export default {
  Query: {
    blockedUsers: async (object, args, context, resolveInfo) => {
      try {
        return getBlockedUsers(context)
      } catch (e) {
        throw new UserInputError(e.message)
      }
    },
    User: async (object, args, context, resolveInfo) => {
      const { email } = args
      if (email) {
        let session
        try {
          session = context.driver.session()
          const readTxResult = await session.readTransaction(txc => {
            const result = txc.run(
              `
            MATCH (user:User)-[:PRIMARY_EMAIL]->(e:EmailAddress {email: $args.email})
            RETURN user`,
              { args },
            )
            return result
          })
          return readTxResult.records.map(r => r.get('user').properties)
        } finally {
          session.close()
        }
      }
      return neo4jgraphql(object, args, context, resolveInfo)
    },
  },
  Mutation: {
    block: async (object, args, context, resolveInfo) => {
      const { user: currentUser } = context
      if (currentUser.id === args.id) return null
      await neode.cypher(
        `
      MATCH(u:User {id: $currentUser.id})-[r:FOLLOWS]->(b:User {id: $args.id})
      DELETE r
      `,
        { currentUser, args },
      )
      const [user, blockedUser] = await Promise.all([
        neode.find('User', currentUser.id),
        neode.find('User', args.id),
      ])
      await user.relateTo(blockedUser, 'blocked')
      return blockedUser.toJson()
    },
    unblock: async (object, args, context, resolveInfo) => {
      const { user: currentUser } = context
      if (currentUser.id === args.id) return null
      await neode.cypher(
        `
      MATCH(u:User {id: $currentUser.id})-[r:BLOCKED]->(b:User {id: $args.id})
      DELETE r
      `,
        { currentUser, args },
      )
      const blockedUser = await neode.find('User', args.id)
      return blockedUser.toJson()
    },
    UpdateUser: async (_parent, params, context, _resolveInfo) => {
      const { termsAndConditionsAgreedVersion } = params
      if (termsAndConditionsAgreedVersion) {
        const regEx = new RegExp(/^[0-9]+\.[0-9]+\.[0-9]+$/g)
        if (!regEx.test(termsAndConditionsAgreedVersion)) {
          throw new ForbiddenError('Invalid version format!')
        }
        params.termsAndConditionsAgreedAt = new Date().toISOString()
      }
      params = await fileUpload(params, { file: 'avatarUpload', url: 'avatar' })
      const session = context.driver.session()

      const writeTxResultPromise = session.writeTransaction(async transaction => {
        const updateUserTransactionResponse = await transaction.run(
          `
            MATCH (user:User {id: $params.id})
            SET user += $params
            SET user.updatedAt = toString(datetime())
            RETURN user
          `,
          { params },
        )
        return updateUserTransactionResponse.records.map(record => record.get('user').properties)
      })
      try {
        const [user] = await writeTxResultPromise
        await createOrUpdateLocations(params.id, params.locationName, session)
        return user
      } catch (error) {
        throw new UserInputError(error.message)
      } finally {
        session.close()
      }
    },
    DeleteUser: async (object, params, context, resolveInfo) => {
      const { resource } = params
      const session = context.driver.session()
      try {
        if (resource && resource.length) {
          await session.writeTransaction(transaction => {
            resource.map(node => {
              return transaction.run(
                `
                    MATCH (resource:${node})<-[:WROTE]-(author:User {id: $userId})
                    OPTIONAL MATCH (resource)<-[:COMMENTS]-(comment:Comment)
                    SET resource.deleted = true
                    SET resource.content = 'UNAVAILABLE'
                    SET resource.contentExcerpt = 'UNAVAILABLE'
                    SET comment.deleted = true
                    RETURN author
                  `,
                {
                  userId: context.user.id,
                },
              )
            })
          })
        }

        const deleteUserTxResultPromise = session.writeTransaction(async transaction => {
          const deleteUserTransactionResponse = await transaction.run(
            `
              MATCH (user:User {id: $userId})
              SET user.deleted = true
              SET user.name = 'UNAVAILABLE'
              SET user.about = 'UNAVAILABLE'
              WITH user
              OPTIONAL MATCH (user)<-[:BELONGS_TO]-(email:EmailAddress)
              DETACH DELETE email
              WITH user
              OPTIONAL MATCH (user)<-[:OWNED_BY]-(socialMedia:SocialMedia)
              DETACH DELETE socialMedia
              RETURN user
            `,
            { userId: context.user.id },
          )
          log(deleteUserTransactionResponse)
          return deleteUserTransactionResponse.records.map(record => record.get('user').properties)
        })
        const [user] = await deleteUserTxResultPromise
        return user
      } finally {
        session.close()
      }
    },
  },
  User: {
    email: async (parent, params, context, resolveInfo) => {
      if (typeof parent.email !== 'undefined') return parent.email
      const { id } = parent
      const statement = `MATCH(u:User {id: {id}})-[:PRIMARY_EMAIL]->(e:EmailAddress) RETURN e`
      const result = await neode.cypher(statement, { id })
      const [{ email }] = result.records.map(r => r.get('e').properties)
      return email
    },
    ...Resolver('User', {
      undefinedToNull: [
        'actorId',
        'avatar',
        'coverImg',
        'deleted',
        'disabled',
        'locationName',
        'about',
        'termsAndConditionsAgreedVersion',
        'termsAndConditionsAgreedAt',
        'allowEmbedIframes',
        'showShoutsPublicly',
        'locale',
      ],
      boolean: {
        followedByCurrentUser:
          'MATCH (this)<-[:FOLLOWS]-(u:User {id: $cypherParams.currentUserId}) RETURN COUNT(u) >= 1',
        isBlocked:
          'MATCH (this)<-[:BLOCKED]-(u:User {id: $cypherParams.currentUserId}) RETURN COUNT(u) >= 1',
      },
      count: {
        contributionsCount:
          '-[:WROTE]->(related:Post) WHERE NOT related.disabled = true AND NOT related.deleted = true',
        friendsCount: '<-[:FRIENDS]->(related:User)',
        followingCount: '-[:FOLLOWS]->(related:User)',
        followedByCount: '<-[:FOLLOWS]-(related:User)',
        commentedCount:
          '-[:WROTE]->(c:Comment)-[:COMMENTS]->(related:Post) WHERE NOT related.disabled = true AND NOT related.deleted = true',
        shoutedCount:
          '-[:SHOUTED]->(related:Post) WHERE NOT related.disabled = true AND NOT related.deleted = true',
        badgesCount: '<-[:REWARDED]-(related:Badge)',
      },
      hasOne: {
        invitedBy: '<-[:INVITED]-(related:User)',
        location: '-[:IS_IN]->(related:Location)',
      },
      hasMany: {
        followedBy: '<-[:FOLLOWS]-(related:User)',
        following: '-[:FOLLOWS]->(related:User)',
        friends: '-[:FRIENDS]-(related:User)',
        socialMedia: '<-[:OWNED_BY]-(related:SocialMedia)',
        contributions: '-[:WROTE]->(related:Post)',
        comments: '-[:WROTE]->(related:Comment)',
        shouted: '-[:SHOUTED]->(related:Post)',
        categories: '-[:CATEGORIZED]->(related:Category)',
        badges: '<-[:REWARDED]-(related:Badge)',
      },
    }),
  },
}
