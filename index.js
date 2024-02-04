import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import cors from "cors";
import express from "express";
import { PubSub } from "graphql-subscriptions";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { createServer } from "http";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/lib/use/ws";
import { ApolloServerErrorCode } from "@apollo/server/errors";
import { GraphQLError } from "graphql";

import axios from "axios";

import "./db.js";
import Person from "./models/person.js";
import User from "./models/user.js";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

const pubsub = new PubSub();

const SUBSCRIPTION_EVENTS = {
  PERSON_ADDED: "PERSON_ADDED",
};

const typeDefinitions = `#graphql
    enum YesNo {
        YES
        NO
    }

    type Address {
        street: String!
        city: String!
    }

    type Person {
        name: String!
        phone: String
        address: Address!
        id: ID!
    }

    type User {
        username: String!
        friends: [Person]!
        id: ID!
    }

    type Token {
        value: String!
    }

    type PersonREST {
        name: String!
        id: ID!
        email: String!
    }

    type Query {
        personCount: Int!
        allPersons(phone: YesNo): [Person]!
        findPerson(name: String!): Person
        allPersonsREST: [PersonREST]!
        me: User
    }

    type Mutation {
        addPerson(
            name: String!
            phone: String
            street: String!
            city: String!
        ): Person
        editNumber(
            name: String!
            phone: String!
        ): Person
        createUser(
            username: String!
        ): User
        login(
            username: String!
            password: String!
        ): Token
        addAsFriend(
            name: String!
        ): User

    }

    type Subscription {
        personAdded: Person!
    }
`;

const resolvers = {
  Query: {
    personCount: async () => await Person.collection.countDocuments(),
    allPersons: async (root, args) => {
      if (!args.phone) {
        return await Person.find({});
      }
      return await Person.find({ phone: { $exists: args.phone === "YES" } });
    },
    findPerson: async (root, args) => await Person.findOne({ name: args.name }),
    allPersonsREST: async () => {
      const { data: users } = await axios.get("http://localhost:3001/users");
      return users;
    },
    me: (root, args, contextValue) => {
      if (!contextValue.currentUser) return null;
      return contextValue.currentUser;
    },
  },
  Mutation: {
    addPerson: async (root, args, contextValue) => {
      const { currentUser } = contextValue;
      if (!currentUser) {
        throw new GraphQLError("User is not authenticated", {
          extensions: { code: ApolloServerErrorCode.UNAUTHENTICATED },
        });
      }
      try {
        await person.save();
        currentUser.friends = currentUser.friends.concat(person);
        await currentUser.save();
      } catch (error) {
        throw new GraphQLError(error.message, {
          extensions: { code: ApolloServerErrorCode.BAD_USER_INPUT },
        });
      }
      const person = new Person({ ...args });
      pubsub.publish(SUBSCRIPTION_EVENTS.PERSON_ADDED, { personAdded: person });
      return person;
    },
    editNumber: async (root, args) => {
      const person = await Person.findOne({ name: args.name });
      if (!person) {
        return null;
      }
      person.phone = args.phone;
      try {
        await person.save();
      } catch (error) {
        throw new GraphQLError(error.message, {
          extensions: { code: ApolloServerErrorCode.BAD_USER_INPUT },
        });
      }
      return person;
    },
    createUser: (root, args) => {
      const user = new User({ username: args.username });
      return user.save().catch((error) => {
        throw new GraphQLError(error.message, {
          extensions: { code: ApolloServerErrorCode.BAD_USER_INPUT },
        });
      });
    },
    login: async (root, args) => {
      const user = await User.findOne({ username: args.username });
      if (!user || args.password !== "secret") {
        throw new GraphQLError("wrong credentials", {
          extensions: { code: ApolloServerErrorCode.BAD_USER_INPUT },
        });
      }
      const userForToken = {
        username: user.username,
        id: user._id,
      };
      return { value: jwt.sign(userForToken, JWT_SECRET) };
    },
    addAsFriend: async (root, args, { currentUser }) => {
      if (!currentUser) {
        throw new GraphQLError("User is not authenticated", {
          extensions: { code: ApolloServerErrorCode.UNAUTHENTICATED },
        });
      }
      const person = await Person.findOne({ name: args.name });
      const nonFriendAlready = (person) =>
        !currentUser.friends.map((f) => f._id).includes(person._id);
      if (nonFriendAlready(person)) {
        currentUser.friends = currentUser.friends.concat(person);
        await currentUser.save();
      }

      return currentUser;
    },
  },
  Person: {
    address: (root) => {
      return {
        street: root.street,
        city: root.city,
      };
    },
  },
  Subscription: {
    personAdded: {
      subscribe: () => pubsub.asyncIterator([SUBSCRIPTION_EVENTS.PERSON_ADDED]),
    },
  },
};

// Create the schema, which will be used separately by ApolloServer and
// the WebSocket server.
const schema = makeExecutableSchema({
  typeDefs: typeDefinitions,
  resolvers,
});

// Create an Express app and HTTP server; we will attach both the WebSocket
// server and the ApolloServer to this HTTP server.
const app = express();
const httpServer = createServer(app);

// Create our WebSocket server using the HTTP server we just set up.
const wsServer = new WebSocketServer({
  server: httpServer,
  path: "/graphql",
});
// Save the returned server's info so we can shutdown this server later
const serverCleanup = useServer(
  {
    schema,
    context: async (ctx, msg, args) => {
      // get the user token from the headers
      const auth = ctx.connectionParams.Authorization;

      // try to retrieve a user with the token
      let currentUser = null;
      if (auth && auth.toLowerCase().startsWith("bearer ")) {
        const decodedToken = jwt.verify(auth.substring(7), JWT_SECRET);
        currentUser = await User.findById(decodedToken.id).populate("friends");
      }

      // optionally block the user
      // we could also check user roles/permissions here
      if (!currentUser)
        // throwing a `GraphQLError` here allows us to specify an HTTP status code,
        // standard `Error`s will have a 500 status code by default
        throw new GraphQLError("User is not authenticated", {
          extensions: {
            code: "UNAUTHENTICATED",
            http: { status: 401 },
          },
        });

      // add the user to the context
      return { currentUser };
    },
  },
  wsServer
);

// Set up ApolloServer.
const server = new ApolloServer({
  schema,
  plugins: [
    // Proper shutdown for the HTTP server.
    ApolloServerPluginDrainHttpServer({ httpServer }),

    // Proper shutdown for the WebSocket server.
    {
      async serverWillStart() {
        return {
          async drainServer() {
            await serverCleanup.dispose();
          },
        };
      },
    },
  ],
});

await server.start();
app.use(
  "/graphql",
  cors(),
  express.json(),
  expressMiddleware(server, {
    context: async ({ req }) => {
      // get the user token from the headers
      const auth = req ? req.headers.authorization : null;

      // try to retrieve a user with the token
      let currentUser = null;
      if (auth && auth.toLowerCase().startsWith("bearer ")) {
        const decodedToken = jwt.verify(auth.substring(7), JWT_SECRET);
        currentUser = await User.findById(decodedToken.id).populate("friends");
      }

      // optionally block the user
      // we could also check user roles/permissions here
      // if (!currentUser)
      //   // throwing a `GraphQLError` here allows us to specify an HTTP status code,
      //   // standard `Error`s will have a 500 status code by default
      //   throw new GraphQLError("User is not authenticated", {
      //     extensions: {
      //       code: "UNAUTHENTICATED",
      //       http: { status: 401 },
      //     },
      //   });

      // add the user to the context
      return { currentUser };
    },
  })
);

const PORT = 4000;
// Now that our HTTP server is fully set up, we can listen to it.
httpServer.listen(PORT, () => {
  console.log(`Server is now running on http://localhost:${PORT}/graphql`);
});
