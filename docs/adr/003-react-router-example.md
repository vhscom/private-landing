# ADR-003: Adding React Router 7 Example App

## Status

Accepted

## Context

The Private Landing monorepo currently includes a Cloudflare Workers example application that demonstrates the authentication system in a simple API setup. While this provides a functional example, it lacks a complete UI implementation, which would better showcase how the authentication system integrates into a full-stack application.

Additionally, React Router 7 has been released with significant improvements to both performance and developer experience, making it an ideal choice for modern web applications.

## Decision

We will add a new example application using React Router 7 on Cloudflare Workers to the monorepo. This example will:

1. Demonstrate modern React best practices and patterns
2. Use React Router 7's newer features, including error boundaries
3. Run on the same Cloudflare Workers platform
4. Serve as a template for full-stack applications
5. Provide a foundation for implementing the authentication system in a UI context

### Technical Details

- The app will be named `@private-landing/react-router`
- It will use React Router 7 with the Cloudflare Workers runtime
- Tailwind CSS for styling
- TypeScript for type safety
- React Aria Components for enhanced accessibility
- Proper error boundaries at both root and route levels
- Minimal dependencies to keep the example clean and focused

### Implementation

The implementation includes:

1. **Project Structure**:
    - Route-based file organization
    - Clear separation of concerns
    - TypeScript for all components

2. **Core Features**:
    - Error handling through React Router 7 error boundaries
    - Server-side rendering with Cloudflare Workers
    - Client-side hydration
    - Example routes demonstrating different patterns

3. **Testing & Build System**:
    - Integration with the monorepo build pipeline
    - Testing setup compatible with Vitest
    - Cloudflare Workers deployment configuration

## Alternatives Considered

### NextJS

NextJS would require a different deployment target and introduce a different programming model. For consistency with the existing example, sticking with Cloudflare Workers is preferable.

### SPA without SSR

A simple single-page application would be easier to implement but wouldn't demonstrate modern edge rendering capabilities that are important for performance and SEO.

## Consequences

### Positive

- Provides a complete full-stack example of the authentication system
- Demonstrates modern React best practices
- Creates a foundation for UI components that can be shared
- Offers a starting point for developers building applications with the monorepo
- Showcases error boundary implementations with proper UX

### Negative

- Adds another example app to maintain
- Increases the surface area of the monorepo
- Requires additional build and testing infrastructure

## Implementation Plan

1. Create the basic app structure using React Router 7
2. Set up the build and deployment pipeline
3. Implement core routes and error boundaries
4. Add the authentication integration
5. Document the implementation

## Related ADRs

- ADR-001: Authentication Implementation

## References

- [React Router 7 Documentation](https://reactrouter.com/en/main)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)